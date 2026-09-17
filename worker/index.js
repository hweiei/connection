/**
 * Tunnel MCP 控制台 & 自动 OAuth 网关 — Cloudflare Worker (v1.5)
 *
 * 职责:
 * 1. 托管前端静态页面 (dist/)
 * 2. /__proxy —— 透明中继 (前端控制台用,浏览器→Worker→隧道,绕开 CORS)
 * 3. /gateway (别名 /__mcp) —— ⭐ 自动 OAuth 网关 + AI GET→POST 桥接:
 *    - 对 POST 请求: 当成免认证的 MCP 端点,Worker 自动用内置 password 登录并注入 Bearer token
 *    - 对 GET  请求: 自动在 Worker 内部完成 MCP initialize 握手(维护 Mcp-Session-Id),并支持:
 *        • GET /gateway                                → 自动握手 + 返回 serverInfo + tools/list 全部工具
 *        • GET /gateway?op=connect                     → 同上,返回完整 serverInfo + tools
 *        • GET /gateway?tool=<工具名>&args=<JSON字符串> → 自动握手 + 调用 tools/call 读本机文件/执行命令
 *        • GET /gateway?method=<JSON-RPC方法>&params=<JSON> → 调用任意 MCP 方法
 *        • GET /gateway/health                         → 查看网关与 token 缓存状态
 *        • GET /gateway/login                          → 强制刷新 OAuth token
 */

const DEFAULT_MCP = "https://affiliates-geek-roger-rides.trycloudflare.com/mcp";
const DEFAULT_PASSWORD = "hQ3mUUJtRsDG8UCC_knqkBIM2rGby1BFhOJm8bOJSdA";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_HOST_SUFFIX = [".trycloudflare.com", ".cfargotunnel.com", ".workers.dev"];

function allowHost(hostname) {
  return ALLOWED_HOST_SUFFIX.some((s) => hostname.endsWith(s));
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function originOf(u) {
  const x = new URL(u);
  return `${x.protocol}//${x.host}`;
}

/* ============ PKCE 工具 ============ */
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randStr(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

async function pkce(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

function parseSSE(text) {
  const msgs = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const s = cur.join("\n").trim();
    cur = [];
    if (!s || s === "[DONE]") return;
    try { msgs.push(JSON.parse(s)); } catch {}
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) cur.push(line.slice(5).trimStart());
    else if (line.trim() === "") flush();
  }
  flush();
  return msgs;
}

/* ============ 全局(实例级)token 与 session 缓存 ============ */
const tokenCache = new Map();   // key: mcpUrl → { token, exp, obtainedAt }
const sessionCache = new Map(); // key: mcpUrl → { sessionId, serverInfo, ts }

/* ============ 自动 OAuth 登录 ============ */
async function autoLogin(mcpUrl, password, log) {
  const origin = originOf(mcpUrl);
  const L = (m, d) => log && log(m, d);

  let asm = null;
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const r = await fetch(origin + p, { headers: { Accept: "application/json" } });
      if (r.ok) { asm = await r.json(); break; }
    } catch {}
  }
  const authorizeUrl = asm?.authorization_endpoint || `${origin}/oauth/authorize`;
  const tokenUrl = asm?.token_endpoint || `${origin}/oauth/token`;
  const registerUrl = asm?.registration_endpoint || `${origin}/oauth/register`;
  L("OAuth 端点", JSON.stringify({ authorizeUrl, tokenUrl, registerUrl }));

  const redirectUri = `${origin}/__gw_cb`;
  let clientId = "tunnel-mcp-gateway";
  let clientSecret;
  try {
    const rr = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Tunnel MCP Gateway",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (rr.ok) {
      const j = await rr.json();
      clientId = j.client_id || clientId;
      clientSecret = j.client_secret;
      L("客户端注册成功", clientId);
    } else {
      L("客户端注册失败,使用默认 clientId", `HTTP ${rr.status}`);
    }
  } catch (e) {
    L("客户端注册异常", String(e));
  }

  const verifier = randStr(64);
  const challenge = await pkce(verifier);
  const state = randStr(24);
  const resource = origin;

  const authUrl = new URL(authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", resource);
  if (asm?.scopes_supported) authUrl.searchParams.set("scope", asm.scopes_supported.join(" "));

  const code = await obtainAuthCode(authUrl.toString(), password, redirectUri, L);
  if (!code) {
    throw new Error("无法从授权页获取授权码 —— 请检查 password 是否正确");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  if (clientSecret) body.set("client_secret", clientSecret);
  body.set("code_verifier", verifier);
  body.set("resource", resource);

  const tr = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const tt = await tr.text();
  if (!tr.ok) throw new Error(`Token 交换失败 HTTP ${tr.status}: ${tt.slice(0, 500)}`);
  const tok = JSON.parse(tt);
  if (!tok.access_token) throw new Error(`响应无 access_token: ${tt.slice(0, 300)}`);

  L("登录成功,已获取 access_token", tok.token_type || "bearer");
  return {
    token: tok.access_token,
    exp: tok.expires_in ? Date.now() + (tok.expires_in - 30) * 1000 : Date.now() + 55 * 60 * 1000,
    obtainedAt: Date.now(),
  };
}

async function obtainAuthCode(authUrl, password, redirectUri, L) {
  const grabCode = (resp) => {
    const loc = resp.headers.get("location");
    if (!loc) return null;
    try {
      const u = new URL(loc, redirectUri);
      const c = u.searchParams.get("code");
      if (c) return c;
    } catch {}
    return null;
  };

  for (const pk of ["password", "key", "token", "auth", "code"]) {
    try {
      const u = new URL(authUrl);
      u.searchParams.set(pk, password);
      const r = await fetch(u.toString(), { redirect: "manual", headers: { Accept: "text/html,application/json" } });
      const c = grabCode(r);
      if (c) { L(`方式A命中 (?${pk}=)`); return c; }
      if (r.status === 200) {
        const txt = await r.text();
        const m = txt.match(/[?&]code=([A-Za-z0-9\-._~]+)/);
        if (m) { L(`方式A命中 (body code, ?${pk}=)`); return m[1]; }
      }
    } catch {}
  }

  try {
    const g = await fetch(authUrl, { redirect: "manual", headers: { Accept: "text/html" } });
    const c0 = grabCode(g);
    if (c0) { L("方式B: 授权页直接返回 code"); return c0; }
    const setCookie = g.headers.get("set-cookie");
    const html = g.status < 400 ? await g.text() : "";
    const formAction = (html.match(/<form[^>]+action=["']([^"']+)["']/i) || [])[1];
    const pwField = (html.match(/name=["'](password|passwd|pwd|key|token|secret)["']/i) || [])[1] || "password";
    const postUrl = formAction ? new URL(formAction, authUrl).toString() : authUrl;

    const src = new URL(authUrl);
    const form = new URLSearchParams();
    for (const [k, v] of src.searchParams) form.set(k, v);
    form.set(pwField, password);

    const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,application/json" };
    if (setCookie) headers["Cookie"] = setCookie.split(";")[0];

    const pr = await fetch(postUrl, { method: "POST", body: form.toString(), redirect: "manual", headers });
    const c = grabCode(pr);
    if (c) { L("方式B: POST 表单命中"); return c; }
    if (pr.status === 200) {
      const t = await pr.text();
      const m = t.match(/[?&]code=([A-Za-z0-9\-._~]+)/) || t.match(/"code"\s*:\s*"([^"]+)"/);
      if (m) { L("方式B: POST 响应体命中"); return m[1]; }
    }
    L("方式B未命中", `POST ${postUrl} → HTTP ${pr.status}`);
  } catch (e) {
    L("方式B异常", String(e));
  }

  try {
    const src = new URL(authUrl);
    const payload = { password };
    for (const [k, v] of src.searchParams) payload[k] = v;
    const jr = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    const c = grabCode(jr);
    if (c) { L("方式C命中"); return c; }
    if (jr.ok) {
      const j = await jr.json().catch(() => ({}));
      if (j.code) { L("方式C: JSON code"); return j.code; }
      if (j.redirect || j.location) {
        const u = new URL(j.redirect || j.location, redirectUri);
        const cc = u.searchParams.get("code");
        if (cc) { L("方式C: JSON redirect code"); return cc; }
      }
    }
  } catch (e) {
    L("方式C异常", String(e));
  }

  return null;
}

async function getToken(mcpUrl, password, forceNew, log, env) {
  const injected = env && env.MCP_TOKEN;
  if (injected && !forceNew) {
    log && log("使用手动注入的 MCP_TOKEN(跳过自动登录)");
    return injected;
  }
  if (!forceNew) {
    const cached = tokenCache.get(mcpUrl);
    if (cached && cached.exp > Date.now()) return cached.token;
  }
  const t = await autoLogin(mcpUrl, password, log);
  tokenCache.set(mcpUrl, t);
  return t.token;
}

/** 发送单次 JSON-RPC 到上游 MCP 并解析 JSON / SSE */
async function rpcCall(mcpUrl, token, sessionId, method, params, id = 1) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = id === null
    ? { jsonrpc: "2.0", method, params: params || {} }
    : { jsonrpc: "2.0", id, method, params: params || {} };

  const res = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(body) });
  const newSid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id") || sessionId;
  const text = await res.text().catch(() => "");
  if (id === null) return { status: res.status, sessionId: newSid, result: { accepted: true } };
  if (!res.ok) {
    const err = new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 800)}`);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    const msgs = parseSSE(text);
    const match = msgs.find((m) => m && m.id === id && ("result" in m || "error" in m))
      || msgs.find((m) => m && ("result" in m || "error" in m))
      || msgs[msgs.length - 1];
    if (match?.error) throw new Error(`JSON-RPC error: ${JSON.stringify(match.error)}`);
    return { status: res.status, sessionId: newSid, result: match?.result ?? match };
  }
  const j = text.trim() ? JSON.parse(text) : {};
  if (j.error) throw new Error(`JSON-RPC error: ${JSON.stringify(j.error)}`);
  return { status: res.status, sessionId: newSid, result: j.result ?? j };
}

/** 确保拿到有效 MCP session (initialize + notifications/initialized) */
async function ensureMcpSession(mcpUrl, token, forceNew = false) {
  if (!forceNew) {
    const cached = sessionCache.get(mcpUrl);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
      return cached;
    }
  }
  const init = await rpcCall(mcpUrl, token, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: "tunnel-mcp-gateway", version: "1.5.0" },
  }, 1);
  const sid = init.sessionId;
  await rpcCall(mcpUrl, token, sid, "notifications/initialized", {}, null);
  const entry = {
    sessionId: sid,
    serverInfo: {
      name: init.result?.serverInfo?.name || "coding-tools-mcp",
      title: init.result?.serverInfo?.title,
      version: init.result?.serverInfo?.version || "-",
      protocolVersion: init.result?.protocolVersion || "2025-06-18",
      capabilities: init.result?.capabilities || {},
      instructions: init.result?.instructions,
    },
    ts: Date.now(),
  };
  sessionCache.set(mcpUrl, entry);
  return entry;
}

/* ============ /gateway 与 /__mcp 处理 ============ */
async function handleGateway(request, url, env) {
  const mcpUrl = (url.searchParams.get("tunnel") || url.searchParams.get("mcp") || (env && env.MCP_URL) || DEFAULT_MCP).trim();
  const password = (url.searchParams.get("password") || (env && env.MCP_PASSWORD) || DEFAULT_PASSWORD).trim();
  const debug = [];
  const log = (m, d) => debug.push(d ? `${m}: ${d}` : m);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // 健康 / 状态
  if (url.pathname.endsWith("/health")) {
    const cached = tokenCache.get(mcpUrl);
    return json({
      ok: true,
      service: "tunnel-mcp-oauth-gateway",
      version: "1.5.0",
      mcpUrl,
      passwordConfigured: !!password,
      token: cached ? { present: true, expiresInSec: Math.max(0, Math.round((cached.exp - Date.now()) / 1000)) } : { present: false },
      usage: {
        listTools: "GET /gateway (自动 OAuth + initialize + tools/list)",
        callTool: "GET /gateway?tool=<工具名>&args=<JSON参数>",
        mcpPost: "POST /gateway (标准免认证 MCP 端点)",
      },
    });
  }

  // 强制重登
  if (url.pathname.endsWith("/login")) {
    try {
      sessionCache.delete(mcpUrl);
      await getToken(mcpUrl, password, true, log, env);
      return json({ ok: true, message: "已重新登录并缓存 token", debug });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e), debug }, 502);
    }
  }

  // ⭐ 当 AI 或浏览器发送 GET 请求到 /gateway 或 /__mcp 时:
  // 在 Worker 内部自动完成 OAuth + initialize + tools/list 或 tools/call
  if (request.method === "GET") {
    try {
      let token = await getToken(mcpUrl, password, false, log, env);
      let sess;
      try {
        sess = await ensureMcpSession(mcpUrl, token, false);
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) {
          tokenCache.delete(mcpUrl);
          sessionCache.delete(mcpUrl);
          token = await getToken(mcpUrl, password, true, log, env);
          sess = await ensureMcpSession(mcpUrl, token, true);
        } else {
          throw e;
        }
      }

      const op = (url.searchParams.get("op") || "").toLowerCase();
      const toolName = url.searchParams.get("tool") || url.searchParams.get("name");
      const rpcMethod = url.searchParams.get("method");

      // 1) 调用具体工具: GET /gateway?tool=exec_command&args={"cmd":"ls"}
      if (toolName || op === "call") {
        if (!toolName) return json({ ok: false, error: "缺少 tool 参数,例如 ?tool=exec_command&args={...}" }, 400);
        let args = {};
        const rawArgs = url.searchParams.get("args");
        if (rawArgs) {
          try { args = JSON.parse(rawArgs); } catch {
            return json({ ok: false, error: `args 不是合法 JSON: ${rawArgs}` }, 400);
          }
        }
        let callRes;
        try {
          callRes = await rpcCall(mcpUrl, token, sess.sessionId, "tools/call", { name: toolName, arguments: args }, 2);
        } catch {
          sess = await ensureMcpSession(mcpUrl, token, true);
          callRes = await rpcCall(mcpUrl, token, sess.sessionId, "tools/call", { name: toolName, arguments: args }, 2);
        }
        return json({
          ok: true,
          op: "call",
          tool: toolName,
          arguments: args,
          sessionId: sess.sessionId,
          serverInfo: sess.serverInfo,
          result: callRes.result,
        });
      }

      // 2) 调用任意 JSON-RPC 方法: GET /gateway?method=tools/list&params={}
      if (rpcMethod) {
        let params = {};
        const rawParams = url.searchParams.get("params");
        if (rawParams) {
          try { params = JSON.parse(rawParams); } catch {}
        }
        const rRes = await rpcCall(mcpUrl, token, sess.sessionId, rpcMethod, params, 2);
        return json({ ok: true, method: rpcMethod, sessionId: sess.sessionId, result: rRes.result });
      }

      // 3) 默认 (GET /gateway 或 GET /gateway?op=connect): 返回完整 serverInfo + tools 列表
      let toolsList;
      try {
        toolsList = await rpcCall(mcpUrl, token, sess.sessionId, "tools/list", {}, 2);
      } catch {
        sess = await ensureMcpSession(mcpUrl, token, true);
        toolsList = await rpcCall(mcpUrl, token, sess.sessionId, "tools/list", {}, 2);
      }

      return json({
        ok: true,
        op: "connect",
        mcpUrl,
        access_token: token,
        sessionId: sess.sessionId,
        serverInfo: sess.serverInfo,
        tools: toolsList.result?.tools || [],
        resources: [],
        prompts: [],
      });
    } catch (e) {
      return json({
        ok: false,
        error: String((e && e.message) || e),
        debug,
      }, 502);
    }
  }

  // POST 请求: 标准透明转发 MCP 请求 (自动带 Bearer token)
  const bodyBuf = await request.arrayBuffer();
  const doForward = async (token) => {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("cf-connecting-ip");
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json, text/event-stream");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(mcpUrl, {
      method: "POST",
      headers,
      body: bodyBuf,
      redirect: "follow",
    });
  };

  try {
    let token = await getToken(mcpUrl, password, false, log, env);
    let upstream = await doForward(token);
    if (upstream.status === 401 || upstream.status === 403) {
      log("上游 401,清缓存重新登录");
      tokenCache.delete(mcpUrl);
      token = await getToken(mcpUrl, password, true, log, env);
      upstream = await doForward(token);
    }
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    out.set("Access-Control-Expose-Headers", "*");
    out.set("X-Gateway", "auto-oauth");
    out.delete("content-encoding");
    out.delete("content-length");
    const ct = upstream.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      out.set("Cache-Control", "no-cache, no-transform");
      out.set("X-Accel-Buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch (e) {
    return json({
      error: "网关自动登录/转发失败",
      detail: String((e && e.message) || e),
      debug,
    }, 502);
  }
}

/* ============ /__proxy 透明中继(前端用) ============ */
async function handleProxy(request, url) {
  if (url.pathname === "/__proxy/health") {
    return json({
      ok: true,
      service: "tunnel-mcp-worker-proxy",
      version: "1.5.0",
      gateway: "/gateway",
      allowedHosts: ALLOWED_HOST_SUFFIX,
      time: new Date().toISOString(),
    });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "缺少 url 参数" }, 400);
  let t;
  try { t = new URL(target); } catch { return json({ error: "url 非法" }, 400); }
  if (t.protocol !== "https:" && t.protocol !== "http:") return json({ error: "只支持 http/https" }, 400);
  if (!allowHost(t.hostname)) return json({ error: `拒绝代理到 ${t.hostname}`, allowed: ALLOWED_HOST_SUFFIX }, 403);

  const drop = new Set(["host", "origin", "referer", "connection", "keep-alive", "content-length", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]);
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!drop.has(k.toLowerCase())) headers.set(k, v);
  headers.set("Host", t.host);
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/event-stream");

  const init = { method: request.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream;
  const started = Date.now();
  try {
    upstream = await fetch(t.toString(), init);
  } catch (e) {
    return json({ error: "代理上游失败", target: t.toString(), detail: String((e && e.message) || e) }, 502);
  }

  const out = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  out.set("Access-Control-Expose-Headers", "*");
  out.set("X-Proxy-Target", t.origin + t.pathname);
  out.set("X-Proxy-Status", String(upstream.status));
  out.set("X-Proxy-Ms", String(Date.now() - started));
  out.delete("content-encoding");
  out.delete("content-length");
  const ct = upstream.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    out.set("Cache-Control", "no-cache, no-transform");
    out.set("X-Accel-Buffering", "no");
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/gateway" ||
      url.pathname.startsWith("/gateway/") ||
      url.pathname === "/__mcp" ||
      url.pathname.startsWith("/__mcp/")
    ) {
      return handleGateway(request, url, env);
    }
    if (url.pathname === "/__proxy" || url.pathname.startsWith("/__proxy/")) {
      return handleProxy(request, url);
    }
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }
    return new Response(
      "Tunnel MCP Worker v1.5 已运行。\n" +
      " /gateway                      自动 OAuth 网关 (GET 列工具/调工具, POST 免认证 MCP 端点)\n" +
      " /gateway?tool=<name>&args={}  GET 直接调用本机 MCP 工具\n" +
      " /gateway/health               网关状态\n" +
      " /__proxy?url=..               透明中继\n",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } }
    );
  },
};

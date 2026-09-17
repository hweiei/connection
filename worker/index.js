/**
 * Tunnel MCP 控制台 & 自动 OAuth 网关 — Cloudflare Worker (v1.6.0)
 */

let dynamicConfig = {
  mcpUrl: "https://affiliates-geek-roger-rides.trycloudflare.com/mcp",
  password: "hQ3mUUJtRsDG8UCC_knqkBIM2rGby1BFhOJm8bOJSdA",
  updatedAt: Date.now(),
};

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

const tokenCache = new Map();
const sessionCache = new Map();

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

  // ⭐ fixUrl: 强制把端点锚定在当前存活的新域名上，彻底解决 530
  const fixUrl = (u, defPath) => {
    if (!u) return `${origin}${defPath}`;
    try {
      const parsed = new URL(u);
      return `${origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return `${origin}${defPath}`;
    }
  };

  const authorizeUrl = fixUrl(asm?.authorization_endpoint, "/oauth/authorize");
  const tokenUrl = fixUrl(asm?.token_endpoint, "/oauth/token");
  const registerUrl = fixUrl(asm?.registration_endpoint, "/oauth/register");
  L("OAuth 端点(已修正)", JSON.stringify({ authorizeUrl, tokenUrl, registerUrl }));

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
  if (!code) throw new Error("无法从授权页获取授权码 —— 请检查 password 是否正确");

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
      if (j.code) return j.code;
      if (j.redirect || j.location) {
        const u = new URL(j.redirect || j.location, redirectUri);
        const cc = u.searchParams.get("code");
        if (cc) return cc;
      }
    }
  } catch (e) {
    L("方式C异常", String(e));
  }

  return null;
}

async function getToken(mcpUrl, password, forceNew, log, env) {
  const injected = env && env.MCP_TOKEN;
  if (injected && !forceNew) return injected;
  if (!forceNew) {
    const cached = tokenCache.get(mcpUrl);
    if (cached && cached.exp > Date.now()) return cached.token;
  }
  const t = await autoLogin(mcpUrl, password, log);
  tokenCache.set(mcpUrl, t);
  return t.token;
}

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

async function ensureMcpSession(mcpUrl, token, forceNew = false) {
  if (!forceNew) {
    const cached = sessionCache.get(mcpUrl);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached;
  }
  const init = await rpcCall(mcpUrl, token, null, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: "tunnel-mcp-gateway", version: "1.6.0" },
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

async function handleGateway(request, url, env) {
  let activeMcpUrl = dynamicConfig.mcpUrl;
  let activePassword = dynamicConfig.password;

  if (env && env.CONFIG_KV) {
    try {
      const kvConf = await env.CONFIG_KV.get("tunnel_config", "json");
      if (kvConf?.mcpUrl) activeMcpUrl = kvConf.mcpUrl;
      if (kvConf?.password) activePassword = kvConf.password;
    } catch {}
  } else if (env && env.MCP_URL) {
    activeMcpUrl = env.MCP_URL;
  }
  if (env && env.MCP_PASSWORD) {
    activePassword = env.MCP_PASSWORD;
  }

  const mcpUrl = (url.searchParams.get("tunnel") || url.searchParams.get("mcp") || activeMcpUrl || DEFAULT_MCP).trim();
  const password = (url.searchParams.get("password") || activePassword || DEFAULT_PASSWORD).trim();
  const debug = [];
  const log = (m, d) => debug.push(d ? `${m}: ${d}` : m);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (url.pathname.endsWith("/sync") || url.pathname.endsWith("/update")) {
    let newTunnel = url.searchParams.get("tunnel") || url.searchParams.get("mcp") || url.searchParams.get("url");
    let newPassword = url.searchParams.get("password") || url.searchParams.get("pwd");

    if (request.method === "POST") {
      try {
        const body = await request.json();
        if (body.tunnel || body.mcp || body.url) newTunnel = body.tunnel || body.mcp || body.url;
        if (body.password || body.pwd) newPassword = body.password || body.pwd;
      } catch {}
    }

    if (!newTunnel && !newPassword) {
      return json({
        ok: false,
        error: "缺少参数。用法: GET /gateway/sync?tunnel=https://新隧道/mcp&password=新密码",
        current: { mcpUrl, passwordConfigured: !!password, updatedAt: new Date(dynamicConfig.updatedAt).toISOString() },
      }, 400);
    }

    if (newTunnel) {
      let tUrl = newTunnel.trim();
      if (!tUrl.startsWith("http")) tUrl = `https://${tUrl}`;
      if (!tUrl.endsWith("/mcp") && !tUrl.includes("/mcp?")) {
        tUrl = tUrl.replace(/\/$/, "") + "/mcp";
      }
      dynamicConfig.mcpUrl = tUrl;
    }
    if (newPassword) {
      dynamicConfig.password = newPassword.trim();
    }
    dynamicConfig.updatedAt = Date.now();

    tokenCache.clear();
    sessionCache.clear();

    return json({
      ok: true,
      message: "🎉 隧道配置已自动同步到云端 Worker!",
      active: {
        mcpUrl: dynamicConfig.mcpUrl,
        password: dynamicConfig.password ? `${dynamicConfig.password.slice(0, 8)}...` : "(未设置)",
        updatedAt: new Date(dynamicConfig.updatedAt).toISOString(),
      },
    });
  }

  if (url.pathname.endsWith("/health")) {
    const cached = tokenCache.get(mcpUrl);
    return json({
      ok: true,
      service: "tunnel-mcp-oauth-gateway",
      version: "1.6.0",
      mcpUrl,
      passwordConfigured: !!password,
      lastSyncAt: new Date(dynamicConfig.updatedAt).toISOString(),
      token: cached ? { present: true, expiresInSec: Math.max(0, Math.round((cached.exp - Date.now()) / 1000)) } : { present: false },
    });
  }

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

      if (toolName || op === "call") {
        if (!toolName) return json({ ok: false, error: "缺少 tool 参数" }, 400);
        let args = {};
        const rawArgs = url.searchParams.get("args");
        if (rawArgs) {
          try { args = JSON.parse(rawArgs); } catch {
            return json({ ok: false, error: "args 不是合法 JSON" }, 400);
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
      });
    } catch (e) {
      return json({
        ok: false,
        error: String((e && e.message) || e),
        debug,
      }, 502);
    }
  }

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
    return fetch(mcpUrl, { method: "POST", headers, body: bodyBuf, redirect: "follow" });
  };

  try {
    let token = await getToken(mcpUrl, password, false, log, env);
    let upstream = await doForward(token);
    if (upstream.status === 401 || upstream.status === 403) {
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
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch (e) {
    return json({ error: "网关转发失败", detail: String((e && e.message) || e), debug }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/gateway" || url.pathname.startsWith("/gateway/")) {
      return handleGateway(request, url, env);
    }
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }
    return new Response("Tunnel MCP Worker v1.6.0", { headers: { ...CORS } });
  },
};

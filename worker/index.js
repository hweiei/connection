/**
 * Tunnel MCP 控制台 & 自动 OAuth 网关 — Cloudflare Worker
 *
 * 职责:
 *  1. 托管前端静态页面(dist/)
 *  2. /__proxy   —— 透明中继(前端控制台用,浏览器→Worker→隧道,绕开 CORS)
 *  3. /gateway   —— ⭐ 自动 OAuth 网关:AI 客户端只发普通 MCP 请求,
 *                    Worker 内部用内置 password 自动完成 OAuth 登录,
 *                    拿到 access_token 后透明转发 MCP 请求。
 *                    AI 完全不需要知道 OAuth 的存在。
 *
 * ── /gateway 用法(给 AI / 命令行) ──────────────────────────────
 *   把它当成一个"无需认证"的 MCP 端点即可:
 *     POST https://connection.32024755.workers.dev/gateway
 *     {"jsonrpc":"2.0","id":1,"method":"initialize", ...}
 *   Worker 会自动:
 *     ① 首次请求时用 password 跑完整 OAuth PKCE 登录,缓存 token
 *     ② 给每个请求加上 Authorization: Bearer <token>
 *     ③ token 过期(401)时自动重新登录并重试一次
 *
 *   GET  /gateway/health   查看网关与 token 状态
 *   POST /gateway/login    强制重新登录(清缓存)
 *
 * ── 配置(在 Cloudflare 控制台 → Settings → Variables 里设置) ──
 *   MCP_URL        隧道 MCP 端点 (默认见 DEFAULT_MCP)
 *   MCP_PASSWORD   OAuth 授权页密码 (默认见 DEFAULT_PASSWORD)
 *   建议把 MCP_PASSWORD 设为 "加密的" Secret 变量。
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
  return new Response(JSON.stringify(data), {
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
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}
async function pkce(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

/* ============ 全局(实例级)token 缓存 ============
 * Worker 实例存活期间复用,避免每次请求都重登。
 * 生产环境可换成 KV / Durable Object 持久化。
 */
const tokenCache = new Map(); // key: mcpUrl → { token, exp, obtainedAt }

/* ============ 自动 OAuth 登录 ============
 * 这台 coding-tools-mcp 的授权流程是:授权页要输入 password。
 * 我们把 password 作为凭证,尝试多种自动化方式跑完整个流程,
 * 拿到最终 access_token。
 */
async function autoLogin(mcpUrl, password, log) {
  const origin = originOf(mcpUrl);
  const L = (m, d) => log && log(m, d);

  // 1. 发现 OAuth 元数据
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

  // 2. 动态注册一个客户端(redirect_uri 用本 Worker 的回环地址,反正我们自己拦截)
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

  // 3. 生成 PKCE
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

  // 4. 提交 password 到授权页,拿授权码。
  //    不同实现方式各异,这里按常见 FastMCP/自建 认证页依次尝试:
  const code = await obtainAuthCode(authUrl.toString(), password, redirectUri, L);
  if (!code) throw new Error("无法从授权页获取授权码 —— password 可能不对,或该服务的授权页不支持自动登录(需要人工在浏览器点按钮)。请改用前端控制台走一次手动 OAuth。");

  // 5. 用授权码换 token
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

/* 从授权页拿授权码:尝试多种自动提交方式 */
async function obtainAuthCode(authUrl, password, redirectUri, L) {
  // 拦截重定向,从 Location 里抓 ?code=
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

  // 方式 A: GET 授权页时直接带 password 参数(部分实现支持 ?password= 或 ?key=)
  for (const pk of ["password", "key", "token", "auth", "code"]) {
    try {
      const u = new URL(authUrl);
      u.searchParams.set(pk, password);
      const r = await fetch(u.toString(), { redirect: "manual", headers: { Accept: "text/html,application/json" } });
      const c = grabCode(r);
      if (c) { L(`方式A命中 (?${pk}=)`); return c; }
      // 有的实现直接把 code 放 body
      if (r.status === 200) {
        const txt = await r.text();
        const m = txt.match(/[?&]code=([A-Za-z0-9\-._~]+)/);
        if (m) { L(`方式A命中 (body code, ?${pk}=)`); return m[1]; }
      }
    } catch {}
  }

  // 方式 B: 先 GET 授权页拿到表单 + cookie,再 POST 提交 password
  try {
    const g = await fetch(authUrl, { redirect: "manual", headers: { Accept: "text/html" } });
    // 可能直接就重定向带 code(无需密码)
    const c0 = grabCode(g);
    if (c0) { L("方式B: 授权页直接返回 code"); return c0; }

    const setCookie = g.headers.get("set-cookie");
    const html = g.status < 400 ? await g.text() : "";
    // 从表单里挖 action、隐藏字段名
    const formAction = (html.match(/<form[^>]+action=["']([^"']+)["']/i) || [])[1];
    const pwField = (html.match(/name=["'](password|passwd|pwd|key|token|secret)["']/i) || [])[1] || "password";
    const postUrl = formAction ? new URL(formAction, authUrl).toString() : authUrl;

    // 收集 GET 时授权页 URL 上的所有参数一起回传
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

  // 方式 C: JSON POST(把 password 当 JSON 提交给授权端点)
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

/* 拿到(或复用)token
 * 优先级: 手动注入的 MCP_TOKEN(env) > 缓存 > 自动登录
 */
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

/* ============ /gateway 处理 ============ */
async function handleGateway(request, url, env) {
  const mcpUrl = (env && env.MCP_URL) || DEFAULT_MCP;
  const password = (env && env.MCP_PASSWORD) || DEFAULT_PASSWORD;
  const debug = [];
  const log = (m, d) => debug.push(d ? `${m}: ${d}` : m);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // 健康 / 状态
  if (url.pathname === "/gateway/health") {
    const cached = tokenCache.get(mcpUrl);
    return json({
      ok: true,
      service: "tunnel-mcp-oauth-gateway",
      mcpUrl,
      passwordConfigured: !!password,
      token: cached ? { present: true, expiresInSec: Math.max(0, Math.round((cached.exp - Date.now()) / 1000)) } : { present: false },
      usage: "把 POST https://<worker>/gateway 当成免认证的 MCP 端点使用即可",
    });
  }

  // 强制重登
  if (url.pathname === "/gateway/login") {
    try {
      await getToken(mcpUrl, password, true, log, env);
      return json({ ok: true, message: "已重新登录并缓存 token", debug });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e), debug }, 502);
    }
  }

  // 主流程: 透明转发 MCP 请求(自动带 token)
  const doForward = async (token) => {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("cf-connecting-ip");
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json, text/event-stream");
    if (!headers.has("Content-Type") && request.method === "POST") headers.set("Content-Type", "application/json");

    const init = { method: request.method, headers, redirect: "follow" };
    if (!["GET", "HEAD"].includes(request.method)) {
      // GET 请求也能用:如果 AI 只发了 GET,我们默认帮它做一次 initialize 探活
      init.body = request.body;
      init.duplex = "half";
    }

    // 特例:AI 发 GET /gateway 时,没有 body → 自动构造一个 initialize
    if (request.method === "GET") {
      init.method = "POST";
      init.body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gateway", version: "1.0" } },
      });
      headers.set("Content-Type", "application/json");
    }

    return fetch(mcpUrl, init);
  };

  try {
    let token = await getToken(mcpUrl, password, false, log, env);
    let upstream = await doForward(token);

    // token 失效 → 重新登录重试一次
    if (upstream.status === 401 || upstream.status === 403) {
      log("上游 401,清缓存重新登录");
      tokenCache.delete(mcpUrl);
      // GET 的 body 已消费,只对 POST 重放;GET 会重新构造 initialize
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
      detail: String(e && e.message || e),
      debug,
      hint: "若因授权页需要人工点按钮而失败,请改用前端控制台手动授权一次;或把有效 token 作为 MCP_TOKEN 环境变量注入。",
    }, 502);
  }
}

/* ============ /__proxy 透明中继(前端用) ============ */
async function handleProxy(request, url) {
  if (url.pathname === "/__proxy/health") {
    return json({
      ok: true, service: "tunnel-mcp-worker-proxy", version: "1.0.0",
      allowedHosts: ALLOWED_HOST_SUFFIX, time: new Date().toISOString(),
    });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const target = url.searchParams.get("url");
  if (!target) return json({ error: "缺少 url 参数" }, 400);
  let t;
  try { t = new URL(target); } catch { return json({ error: "url 非法" }, 400); }
  if (t.protocol !== "https:" && t.protocol !== "http:") return json({ error: "只支持 http/https" }, 400);
  if (!allowHost(t.hostname)) return json({ error: `拒绝代理到 ${t.hostname}`, allowed: ALLOWED_HOST_SUFFIX }, 403);

  const drop = new Set(["host", "origin", "referer", "connection", "keep-alive", "content-length",
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]);
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!drop.has(k.toLowerCase())) headers.set(k, v);
  headers.set("Host", t.host);
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/event-stream");

  const init = { method: request.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(request.method)) { init.body = request.body; init.duplex = "half"; }

  let upstream;
  const started = Date.now();
  try {
    upstream = await fetch(t.toString(), init);
  } catch (e) {
    return json({ error: "代理上游失败", target: t.toString(), detail: String(e && e.message || e) }, 502);
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
  if (ct.includes("text/event-stream")) { out.set("Cache-Control", "no-cache, no-transform"); out.set("X-Accel-Buffering", "no"); }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/gateway" || url.pathname.startsWith("/gateway/")) {
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
      "Tunnel MCP Worker 已运行。\n" +
      "  /gateway         自动 OAuth 网关(AI 直接当免认证 MCP 端点用)\n" +
      "  /gateway/health  网关状态\n" +
      "  /gateway/login   强制重新登录\n" +
      "  /__proxy?url=..  透明中继(前端控制台用)\n",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } }
    );
  },
};

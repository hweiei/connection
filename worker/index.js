/**
 * Tunnel MCP 控制台 — Cloudflare Worker
 *
 * 两个职责:
 *  1. 托管前端静态页面(dist/)
 *  2. 作为「服务端中继」代理前端 → 你的 Cloudflare 隧道
 *     浏览器 →(同源,无 CORS)→ Worker →(服务端直连,无 CORS)→ trycloudflare 隧道
 *
 * 代理端点:
 *   ANY  /__proxy?url=<完整URL编码后的目标地址>
 *   GET  /__proxy/health          健康检查(前端用它自动探测代理是否可用)
 *
 * 部署:
 *   npm run build && npx wrangler deploy
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// 只允许代理到这些主机后缀,避免 Worker 变成开放代理被滥用
const ALLOWED_HOST_SUFFIX = [
  ".trycloudflare.com",
  ".cfargotunnel.com",
  ".workers.dev",
];
// 如果你用自有域名做隧道,把域名加到上面数组里即可

function allowHost(hostname) {
  return ALLOWED_HOST_SUFFIX.some((s) => hostname.endsWith(s));
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

async function handleProxy(request, url) {
  // 健康检查
  if (url.pathname === "/__proxy/health") {
    return json({
      ok: true,
      service: "tunnel-mcp-worker-proxy",
      version: "1.0.0",
      allowedHosts: ALLOWED_HOST_SUFFIX,
      time: new Date().toISOString(),
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const target = url.searchParams.get("url");
  if (!target) {
    return json({ error: "缺少 url 查询参数。用法: /__proxy?url=<encodeURIComponent(目标地址)>" }, 400);
  }

  let t;
  try {
    t = new URL(target);
  } catch {
    return json({ error: `目标地址不是合法 URL: ${target}` }, 400);
  }
  if (t.protocol !== "https:" && t.protocol !== "http:") {
    return json({ error: "只支持 http/https" }, 400);
  }
  if (!allowHost(t.hostname)) {
    return json({
      error: `出于安全考虑,拒绝代理到 ${t.hostname}`,
      hint: `请把该域名后缀加入 worker/index.js 的 ALLOWED_HOST_SUFFIX`,
      allowed: ALLOWED_HOST_SUFFIX,
    }, 403);
  }

  // 透传请求头(剔除 hop-by-hop 和会让上游困惑的头)
  const drop = new Set([
    "host", "origin", "referer", "connection", "keep-alive",
    "content-length", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
    "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  ]);
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!drop.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("Host", t.host);
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/event-stream");
  headers.set("User-Agent", headers.get("User-Agent") || "tunnel-mcp-worker/1.0");

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
    // Workers 转发流式 body 时需要 duplex
    init.duplex = "half";
  }

  let upstream;
  const started = Date.now();
  try {
    upstream = await fetch(t.toString(), init);
  } catch (e) {
    return json({
      error: "代理请求上游失败",
      target: t.toString(),
      detail: String(e && e.message ? e.message : e),
      hint: "隧道可能已掉线,或本机 cloudflared / MCP 进程未运行",
    }, 502);
  }

  // 回传响应,附加 CORS 与调试头;SSE 走流式不缓冲
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

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) 代理路由
    if (url.pathname === "/__proxy" || url.pathname.startsWith("/__proxy/")) {
      return handleProxy(request, url);
    }

    // 2) 静态资源 (Workers Assets 绑定)
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      // SPA 回退: 任何未匹配路径都返回 index.html
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }

    // 3) 没有 ASSETS 绑定时的兜底提示
    return new Response(
      "Tunnel MCP Worker 已运行,但未绑定静态资源。\n" +
      "请在 wrangler.toml 中配置 [assets] directory = \"./dist\" 后重新部署。\n\n" +
      "代理端点可用: /__proxy?url=<目标地址>\n" +
      "健康检查: /__proxy/health\n",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } }
    );
  },
};

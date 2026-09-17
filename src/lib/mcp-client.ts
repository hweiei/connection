/* MCP Streamable-HTTP 客户端 + OAuth 2.1 PKCE 辅助函数 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
  annotations?: any;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
  capabilities?: any;
  instructions?: string;
}

export type LogLevel = "info" | "success" | "error" | "warn" | "request" | "response";

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
  detail?: string;
}

export class McpAuthRequiredError extends Error {
  wwwAuth: string | null;
  constructor(wwwAuth: string | null) {
    super("需要 OAuth 认证");
    this.wwwAuth = wwwAuth;
  }
}

function parseSSE(text: string): any[] {
  const messages: any[] = [];
  const lines = text.split(/\r?\n/);
  let currentData: string[] = [];
  const flush = () => {
    if (currentData.length === 0) return;
    const dataStr = currentData.join("\n");
    currentData = [];
    if (!dataStr.trim()) return;
    if (dataStr.trim() === "[DONE]") return;
    try {
      messages.push(JSON.parse(dataStr));
    } catch {
      // 忽略非 JSON 的 data
    }
  };
  for (const line of lines) {
    if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      flush();
    } else if (line.startsWith("event:")) {
      // event 行忽略,靠 data 驱动
    } else if (line.startsWith(":")) {
      // 注释心跳
    }
  }
  flush();
  return messages;
}

export interface McpRequestOptions {
  timeoutMs?: number;
}

export class McpClient {
  url: string;
  token: string | null = null;
  sessionId: string | null = null;
  protocolVersion = "2025-06-18";
  serverInfo: ServerInfo | null = null;
  private reqId = 1;
  onLog: (level: LogLevel, message: string, detail?: string) => void = () => {};
  onSession: (sid: string | null) => void = () => {};

  constructor(url: string, token?: string | null) {
    this.url = url.trim().replace(/\/$/, "");
    if (token) this.token = token.trim();
  }

  setToken(t: string | null) {
    this.token = t && t.trim() ? t.trim() : null;
  }

  setUrl(u: string) {
    this.url = u.trim().replace(/\/$/, "");
  }

  private log(level: LogLevel, message: string, detail?: string) {
    try {
      this.onLog(level, message, detail);
    } catch {}
  }

  async rawRequest(method: string, params?: any, opts?: McpRequestOptions): Promise<any> {
    const id = this.reqId++;
    const body = { jsonrpc: "2.0", id, method, params: params || {} };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    this.log("request", `→ ${method}`, JSON.stringify(body, null, 2));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 60000);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: any) {
      clearTimeout(timeout);
      if (e?.name === "AbortError") throw new Error("请求超时(60s),请检查隧道是否在线");
      throw new Error(
        `网络请求失败: ${e?.message || e}\n\n可能原因:\n1. 隧道已过期/掉线(trycloudflare 链接是临时的)\n2. 浏览器 CORS 被拦截 —— 需要服务端允许跨域\n3. 目标地址需要 VPN/内网环境`
      );
    } finally {
      clearTimeout(timeout);
    }

    // 会话 ID
    const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid;
      this.onSession(sid);
      this.log("info", `会话 ID 已更新: ${sid.slice(0, 12)}…`);
    }

    if (res.status === 401 || res.status === 403) {
      const www = res.headers.get("www-authenticate");
      const text = await res.text().catch(() => "");
      this.log("warn", `认证失败 HTTP ${res.status}`, (www || "") + "\n" + text.slice(0, 2000));
      throw new McpAuthRequiredError(www);
    }

    // 404 + session 失效时,按 MCP 规范应重新 initialize
    if (res.status === 404 && this.sessionId) {
      this.log("warn", "会话失效(404),正在清除 Session 并重试一次…");
      this.sessionId = null;
      this.onSession(null);
      // 重试一次(去掉 session 头)
      return this.rawRequest(method, params, opts);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 3000)}`);
    }

    const ct = res.headers.get("content-type") || "";
    if (res.status === 202) {
      this.log("response", `← ${method} (202 Accepted, 无内容)`);
      return { accepted: true };
    }

    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      this.log("response", `← ${method} (SSE 流)`, text.slice(0, 4000));
      const msgs = parseSSE(text);
      // 找带 result/error 且 id 匹配的
      const match =
        msgs.find((m) => m && m.id === id && ("result" in m || "error" in m)) ||
        msgs.find((m) => m && ("result" in m || "error" in m)) ||
        msgs[msgs.length - 1];
      if (!match) throw new Error(`SSE 响应中没有有效消息:\n${text.slice(0, 2000)}`);
      if (match.error) throw new Error(`JSON-RPC 错误: ${JSON.stringify(match.error, null, 2)}`);
      return match.result;
    } else {
      const text = await res.text();
      // 某些实现即使声明 json 也返回 SSE 格式
      if (text.startsWith("event:") || text.includes("\ndata: ")) {
        this.log("response", `← ${method} (SSE 文本)`, text.slice(0, 4000));
        const msgs = parseSSE(text);
        const match =
          msgs.find((m) => m && m.id === id && ("result" in m || "error" in m)) ||
          msgs.find((m) => m && ("result" in m || "error" in m)) ||
          msgs[msgs.length - 1];
        if (!match) throw new Error(`SSE 响应中没有有效消息:\n${text.slice(0, 2000)}`);
        if (match.error) throw new Error(`JSON-RPC 错误: ${JSON.stringify(match.error, null, 2)}`);
        return match.result;
      }
      this.log("response", `← ${method} (JSON)`, text.slice(0, 4000));
      if (!text.trim()) return { accepted: true };
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`无法解析 JSON 响应:\n${text.slice(0, 2000)}`);
      }
      if (json.error) throw new Error(`JSON-RPC 错误: ${JSON.stringify(json.error, null, 2)}`);
      return json.result ?? json;
    }
  }

  async sendNotification(method: string, params?: any) {
    const body: any = { jsonrpc: "2.0", method, params: params || {} };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    this.log("request", `→ ${method} (notification)`, JSON.stringify(body));
    try {
      const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
      const sid = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id");
      if (sid && !this.sessionId) {
        this.sessionId = sid;
        this.onSession(sid);
      }
      await res.text().catch(() => "");
    } catch (e: any) {
      this.log("warn", `通知 ${method} 发送失败: ${e?.message}`);
    }
  }

  async initialize(): Promise<ServerInfo> {
    const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];
    let lastErr: any = null;
    for (const v of versions) {
      try {
        this.protocolVersion = v;
        this.log("info", `尝试握手,协议版本 ${v} …`);
        const result = await this.rawRequest("initialize", {
          protocolVersion: v,
          capabilities: { roots: { listChanged: true }, sampling: {} },
          clientInfo: { name: "tunnel-mcp-console", version: "1.0.0" },
        });
        await this.sendNotification("notifications/initialized");
        this.serverInfo = {
          name: result?.serverInfo?.name || "未知服务",
          version: result?.serverInfo?.version || "-",
          protocolVersion: result?.protocolVersion || v,
          capabilities: result?.capabilities || {},
          instructions: result?.instructions,
        };
        this.log("success", `握手成功: ${this.serverInfo.name} v${this.serverInfo.version}`, JSON.stringify(result, null, 2));
        return this.serverInfo;
      } catch (e: any) {
        if (e instanceof McpAuthRequiredError) throw e;
        lastErr = e;
        this.log("warn", `版本 ${v} 握手失败: ${String(e?.message).split("\n")[0]}`);
        // 如果是协议版本不支持则继续尝试下一个版本,否则直接抛
        const msg = String(e?.message || "");
        if (msg.includes("protocol") || msg.includes("version") || msg.includes("Unsupported") || msg.includes("-32602") || msg.includes("-32601")) {
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error("所有协议版本握手均失败");
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.rawRequest("tools/list", {});
    return r?.tools || [];
  }
  async listResources(): Promise<McpResource[]> {
    const r = await this.rawRequest("resources/list", {});
    return r?.resources || [];
  }
  async listPrompts(): Promise<McpPrompt[]> {
    const r = await this.rawRequest("prompts/list", {});
    return r?.prompts || [];
  }
  async callTool(name: string, args: any): Promise<any> {
    return await this.rawRequest("tools/call", { name, arguments: args || {} }, { timeoutMs: 120000 });
  }
  async readResource(uri: string): Promise<any> {
    return await this.rawRequest("resources/read", { uri });
  }
  async getPrompt(name: string, args: any): Promise<any> {
    return await this.rawRequest("prompts/get", { name, arguments: args || {} });
  }
  async ping(): Promise<any> {
    return await this.rawRequest("ping", {});
  }
}

/* ---------------- OAuth 2.1 PKCE ---------------- */

export function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(len = 64): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

export function getOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  }
}

export interface OAuthDiscovery {
  protectedResource?: any;
  authServer?: any;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer: string;
  scopesSupported?: string[];
  discovered: boolean;
  corsBlocked: boolean;
}

/* 错误分类:帮助用户理解到底卡在哪 */
export type ErrorKind = "cors" | "network" | "auth" | "http" | "timeout" | "other";
export function classifyError(e: any): ErrorKind {
  if (e instanceof McpAuthRequiredError) return "auth";
  const msg = String(e?.message || e || "");
  if (msg.includes("超时")) return "timeout";
  if (e?.name === "TypeError" || msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("Load failed") || msg.includes("网络请求失败")) return "cors";
  if (/^HTTP \d{3}/.test(msg)) return "http";
  return "other";
}

/* ---------------- 连接诊断 ---------------- */
export type DiagState = "pending" | "running" | "ok" | "warn" | "fail";
export interface DiagStep {
  id: string;
  title: string;
  state: DiagState;
  detail?: string;
  raw?: string;
}
export type Verdict =
  | "unreachable"      // 隧道不可达
  | "cors_blocked"     // 服务端没有 CORS
  | "mcp_cors_blocked" // well-known 可读但 /mcp 跨域失败
  | "auth_required"    // 需要 OAuth
  | "open"             // 无需认证,直接连
  | "http_error"       // 其他 HTTP 错误
  | "unknown";

export interface DiagResult {
  steps: DiagStep[];
  verdict: Verdict;
  metadata?: any;
  mcpStatus?: number;
  wwwAuth?: string | null;
  exposeSession?: boolean;
}

export async function runDiagnostics(
  mcpUrl: string,
  onStep: (steps: DiagStep[]) => void,
): Promise<DiagResult> {
  const origin = getOrigin(mcpUrl);
  const steps: DiagStep[] = [
    { id: "reach", title: "隧道可达性(Cloudflare 边缘 → 你的本机)", state: "pending" },
    { id: "cors", title: "浏览器跨域(CORS)能否读取服务端响应", state: "pending" },
    { id: "meta", title: "OAuth 授权服务器元数据", state: "pending" },
    { id: "mcp", title: "MCP 端点握手(POST initialize,未带 token)", state: "pending" },
  ];
  const emit = () => onStep(steps.map((s) => ({ ...s })));
  const set = (id: string, patch: Partial<DiagStep>) => {
    const s = steps.find((x) => x.id === id)!;
    Object.assign(s, patch);
    emit();
  };
  const metaUrl = `${origin}/.well-known/oauth-authorization-server`;

  // 1. 可达性(no-cors 模式:只要有 HTTP 响应就算通,即使被 CORS 拦)
  set("reach", { state: "running" });
  let reachable = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    await fetch(metaUrl, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    reachable = true;
    set("reach", { state: "ok", detail: `${origin} 有 HTTP 响应` });
  } catch (e: any) {
    set("reach", { state: "fail", detail: e?.name === "AbortError" ? "12 秒无响应(隧道可能已掉线)" : `无法建立连接: ${e?.message || e}` });
  }

  // 2. CORS + 3. 元数据
  set("cors", { state: "running" });
  let corsOk = false;
  let metadata: any = null;
  try {
    const r = await fetch(metaUrl, { cache: "no-store", headers: { Accept: "application/json" } });
    corsOk = true;
    set("cors", { state: "ok", detail: `响应可读(HTTP ${r.status}),服务端已返回 Access-Control-Allow-Origin` });
    set("meta", { state: "running" });
    if (r.ok) {
      const txt = await r.text();
      try {
        metadata = JSON.parse(txt);
        set("meta", {
          state: "ok",
          detail: `authorize: ${metadata.authorization_endpoint || "-"}\ntoken: ${metadata.token_endpoint || "-"}\nregister: ${metadata.registration_endpoint || "-"}`,
          raw: JSON.stringify(metadata, null, 2),
        });
      } catch {
        set("meta", { state: "warn", detail: "返回的不是 JSON", raw: txt.slice(0, 1000) });
      }
    } else {
      set("meta", { state: "warn", detail: `HTTP ${r.status},未提供元数据(将使用默认 /oauth/* 端点)` });
    }
  } catch (e: any) {
    set("cors", {
      state: reachable ? "fail" : "warn",
      detail: reachable
        ? "服务端有响应,但浏览器读不到 —— 响应缺少 Access-Control-Allow-Origin 头(CORS 未开启)"
        : "无法连接,跳过",
    });
    set("meta", { state: "warn", detail: "因 CORS/网络原因无法读取" });
  }

  // 4. MCP 端点
  set("mcp", { state: "running" });
  let mcpStatus: number | undefined;
  let wwwAuth: string | null = null;
  let mcpCorsOk = false;
  let exposeSession = false;
  try {
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diag", version: "1.0" } },
      }),
    });
    mcpCorsOk = true;
    mcpStatus = r.status;
    wwwAuth = r.headers.get("www-authenticate");
    exposeSession = !!(r.headers.get("mcp-session-id"));
    const body = await r.text().catch(() => "");
    if (r.status === 401 || r.status === 403) {
      set("mcp", {
        state: "warn",
        detail: `HTTP ${r.status} —— 服务端要求 OAuth 认证(这是正常的,需要先授权拿 token)`,
        raw: (wwwAuth ? `WWW-Authenticate: ${wwwAuth}\n\n` : "") + body.slice(0, 1500),
      });
    } else if (r.ok) {
      set("mcp", {
        state: "ok",
        detail: `HTTP ${r.status} —— 端点无需认证,可以直接连接${exposeSession ? "" : "(注意:未读到 Mcp-Session-Id 头,可能需要 Expose-Headers)"}`,
        raw: body.slice(0, 1500),
      });
    } else {
      set("mcp", { state: "fail", detail: `HTTP ${r.status} ${r.statusText}`, raw: body.slice(0, 1500) });
    }
  } catch (e: any) {
    set("mcp", {
      state: "fail",
      detail: corsOk
        ? "well-known 可读,但 /mcp 的 POST 跨域失败 —— 常见原因:① 服务端 OPTIONS 预检未处理 ② 401 响应缺少 CORS 头(认证中间件排在 CORS 中间件之前)"
        : reachable
          ? "跨域被拦截(CORS 未开启),浏览器无法读取 /mcp 的响应"
          : `无法连接: ${e?.message || e}`,
    });
  }

  let verdict: Verdict = "unknown";
  if (!reachable && !corsOk && !mcpCorsOk) verdict = "unreachable";
  else if (reachable && !corsOk && !mcpCorsOk) verdict = "cors_blocked";
  else if (corsOk && !mcpCorsOk) verdict = "mcp_cors_blocked";
  else if (mcpStatus === 401 || mcpStatus === 403) verdict = "auth_required";
  else if (mcpStatus && mcpStatus >= 200 && mcpStatus < 300) verdict = "open";
  else if (mcpStatus) verdict = "http_error";

  return { steps: steps.map((s) => ({ ...s })), verdict, metadata, mcpStatus, wwwAuth, exposeSession };
}

export async function discoverOAuth(mcpUrl: string, log?: (m: string, d?: string) => void): Promise<OAuthDiscovery> {
  const origin = getOrigin(mcpUrl);
  let path = "/mcp";
  try { path = new URL(mcpUrl).pathname || "/mcp"; } catch {}
  const candidates = [
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  let prm: any = null;
  let prmUrl = "";
  let corsBlocked = false;
  for (const c of candidates) {
    try {
      log?.(`发现保护资源元数据: ${c}`);
      const r = await fetch(c, { headers: { Accept: "application/json" } });
      if (r.ok) {
        prm = await r.json();
        prmUrl = c;
        log?.(`✓ 保护资源元数据`, JSON.stringify(prm, null, 2));
        break;
      }
    } catch (e: any) {
      if (classifyError(e) === "cors") corsBlocked = true;
    }
  }
  // 确定授权服务器
  let authServers: string[] = prm?.authorization_servers || [];
  if (authServers.length === 0) authServers = [origin];
  const issuer = authServers[0].replace(/\/$/, "");
  // 拉取授权服务器元数据
  const metaCandidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
    `${origin}/.well-known/oauth-authorization-server`,
  ];
  let asm: any = null;
  for (const c of metaCandidates) {
    try {
      log?.(`发现授权服务器元数据: ${c}`);
      const r = await fetch(c, { headers: { Accept: "application/json" } });
      if (r.ok) {
        asm = await r.json();
        corsBlocked = false;
        log?.(`✓ 授权服务器元数据`, JSON.stringify(asm, null, 2));
        break;
      }
    } catch (e: any) {
      if (classifyError(e) === "cors") corsBlocked = true;
    }
  }
  // 兜底:这台 coding-tools-mcp 的实际端点在 /oauth/* 下
  const authorizationEndpoint = asm?.authorization_endpoint || `${issuer}/oauth/authorize`;
  const tokenEndpoint = asm?.token_endpoint || `${issuer}/oauth/token`;
  const registrationEndpoint = asm?.registration_endpoint || `${issuer}/oauth/register`;
  if (!asm) log?.(`未能读取授权服务器元数据${corsBlocked ? "(被 CORS 拦截)" : ""},使用已知端点 /oauth/authorize、/oauth/token、/oauth/register`);
  if (!prmUrl && !asm) log?.(`未找到保护资源元数据`);
  return {
    protectedResource: prm,
    authServer: asm,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    issuer,
    scopesSupported: asm?.scopes_supported,
    discovered: !!asm,
    corsBlocked,
  };
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  log?: (m: string, d?: string) => void
): Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method?: string }> {
  log?.(`动态注册客户端: ${registrationEndpoint}`);
  // 只申请服务端声明支持的能力(该服务只支持 authorization_code,不支持 refresh_token)
  const body = {
    client_name: "Tunnel MCP Console",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const r = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`客户端注册失败 HTTP ${r.status}: ${text.slice(0, 1000)}`);
  const j = JSON.parse(text);
  log?.(`✓ 客户端注册成功: ${j.client_id}`, text.slice(0, 2000));
  return j;
}

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource?: string;
  scope?: string;
}): string {
  const u = new URL(opts.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  if (opts.resource) u.searchParams.set("resource", opts.resource);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  return u.toString();
}

export async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  resource?: string;
}): Promise<any> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", opts.code);
  body.set("redirect_uri", opts.redirectUri);
  body.set("client_id", opts.clientId);
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);
  body.set("code_verifier", opts.codeVerifier);
  if (opts.resource) body.set("resource", opts.resource);
  const r = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Token 交换失败 HTTP ${r.status}: ${text.slice(0, 2000)}`);
  return JSON.parse(text);
}

/* 从用户粘贴的回调 URL / 纯授权码中提取 code 和 state */
export function parseCallbackInput(input: string): { code: string; state?: string } | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const code = u.searchParams.get("code");
    if (code) return { code, state: u.searchParams.get("state") || undefined };
    // 有些实现把参数放在 hash 里
    const hp = new URLSearchParams(u.hash.replace(/^#/, ""));
    if (hp.get("code")) return { code: hp.get("code")!, state: hp.get("state") || undefined };
  } catch {}
  // 形如 code=xxx&state=yyy
  if (s.includes("code=")) {
    const p = new URLSearchParams(s.replace(/^\?/, ""));
    if (p.get("code")) return { code: p.get("code")!, state: p.get("state") || undefined };
  }
  // 纯授权码
  if (/^[A-Za-z0-9\-._~+/=]+$/.test(s)) return { code: s };
  return null;
}

/* PKCE 会话存取(用 localStorage,让弹出的回调标签页也能拿到 verifier) */
export interface PkceSession {
  verifier: string;
  state: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  mcpUrl: string;
  createdAt: number;
}
const PKCE_KEY = "mcp_oauth_pkce";
export const OAUTH_RESULT_KEY = "mcp_oauth_result";
export function savePkce(s: PkceSession) {
  try { localStorage.setItem(PKCE_KEY, JSON.stringify(s)); } catch {}
  try { sessionStorage.setItem(PKCE_KEY, JSON.stringify(s)); } catch {}
}
export function loadPkce(): PkceSession | null {
  try {
    const a = localStorage.getItem(PKCE_KEY) || sessionStorage.getItem(PKCE_KEY);
    return a ? JSON.parse(a) : null;
  } catch { return null; }
}
export function clearPkce() {
  try { localStorage.removeItem(PKCE_KEY); } catch {}
  try { sessionStorage.removeItem(PKCE_KEY); } catch {}
}
export function isHttpOrigin(): boolean {
  return /^https?:$/.test(window.location.protocol) && window.location.origin !== "null";
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PlugZap, Unplug, Copy, Check, Wrench, Database, MessagesSquare, TerminalSquare,
  Play, Loader2, ShieldCheck, Globe, Server, Activity, Search, Zap, ChevronRight,
  KeyRound, Eye, EyeOff, RefreshCw, X, Sparkles, ArrowRight, Radio, Stethoscope,
  Lock, CircleCheck, TriangleAlert, Info, Trash2, Download, ExternalLink, Braces, ListTree,
  CircleDashed, XCircle, ClipboardPaste, MonitorSmartphone, Code2, LifeBuoy, PartyPopper,
} from "lucide-react";
import {
  McpClient, McpAuthRequiredError, McpTool, McpResource, McpPrompt,
  ServerInfo, LogEntry, LogLevel, DiagStep, DiagResult, Verdict,
  discoverOAuth, registerClient, buildAuthorizeUrl, exchangeCode,
  randomString, pkceChallenge, getOrigin, runDiagnostics, classifyError,
  parseCallbackInput, savePkce, loadPkce, clearPkce, isHttpOrigin, OAUTH_RESULT_KEY,
} from "./lib/mcp-client";
import {
  pythonCorsSnippet, nodeCorsSnippet, claudeCodeCmd, inspectorCmd,
  cursorConfig, claudeDesktopConfig, tokenConfig, curlSnippet,
} from "./lib/snippets";

/* ============ 预填:用户提供的隧道信息 ============ */
const DEFAULT_TUNNEL = "https://affiliates-geek-roger-rides.trycloudflare.com";
const DEFAULT_MCP = "https://affiliates-geek-roger-rides.trycloudflare.com/mcp";
const DEFAULT_PASSWORD = "hQ3mUUJtRsDG8UCC_knqkBIM2rGby1BFhOJm8bOJSdA";

type Status = "disconnected" | "connecting" | "connected" | "auth_required" | "error";

let logId = 1;
const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

/* ---------- 小组件 ---------- */
function CopyBtn({ text, className = "", label = "复制" }: { text: string; className?: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1400);
        }).catch(() => {});
      }}
      className={`inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-300 ${className}`}
    >
      {ok ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {ok ? "已复制" : label}
    </button>
  );
}

function JsonView({ data, maxHeight = "320px" }: { data: any; maxHeight?: string }) {
  const html = useMemo(() => {
    const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return json
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?/g, (_m, str, _e, colon) => {
        if (colon) return `<span class="text-sky-300">${str}</span><span class="text-slate-500">${colon}</span>`;
        return `<span class="text-emerald-300">${str}</span>`;
      })
      .replace(/\b(true|false|null)\b/g, '<span class="text-amber-300">$1</span>')
      .replace(/(^|[\s\[{,:])-?\d+(\.\d+)?([eE][+-]?\d+)?/g, (m) => {
        const num = m.match(/-?\d.*/)?.[0] || "";
        const prefix = m.slice(0, m.length - num.length);
        return `${prefix}<span class="text-violet-300">${num}</span>`;
      });
  }, [data]);
  return (
    <pre
      className="code-font overflow-auto rounded-xl border border-white/10 bg-black/50 p-4 text-[12px] leading-relaxed"
      style={{ maxHeight }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function CodeBlock({ code, maxHeight = 260 }: { code: string; maxHeight?: number }) {
  return (
    <div className="relative">
      <CopyBtn text={code} className="absolute right-2 top-2 z-10" />
      <pre className="code-font overflow-auto rounded-xl border border-white/10 bg-black/60 p-3 pr-20 text-[11.5px] leading-relaxed text-slate-300" style={{ maxHeight }}>{code}</pre>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, string> = {
    disconnected: "bg-slate-500",
    connecting: "bg-amber-400 animate-pulse-glow",
    connected: "bg-emerald-400",
    auth_required: "bg-orange-400 animate-pulse-glow",
    error: "bg-rose-500",
  };
  const ring: Record<Status, string> = {
    disconnected: "",
    connecting: "ring-4 ring-amber-400/20",
    connected: "ring-4 ring-emerald-400/20",
    auth_required: "ring-4 ring-orange-400/20",
    error: "ring-4 ring-rose-500/20",
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${map[status]} ${ring[status]}`} />;
}

const levelStyle: Record<LogLevel, { icon: any; color: string }> = {
  info: { icon: Info, color: "text-sky-300" },
  success: { icon: CircleCheck, color: "text-emerald-300" },
  error: { icon: TriangleAlert, color: "text-rose-300" },
  warn: { icon: TriangleAlert, color: "text-amber-300" },
  request: { icon: ArrowRight, color: "text-violet-300" },
  response: { icon: ChevronRight, color: "text-cyan-300" },
};

function DiagIcon({ state }: { state: DiagStep["state"] }) {
  if (state === "pending") return <CircleDashed size={16} className="text-slate-600" />;
  if (state === "running") return <Loader2 size={16} className="animate-spin text-cyan-300" />;
  if (state === "ok") return <CircleCheck size={16} className="text-emerald-400" />;
  if (state === "warn") return <TriangleAlert size={16} className="text-amber-400" />;
  return <XCircle size={16} className="text-rose-400" />;
}

function EmptyState({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="flex min-h-[380px] flex-col items-center justify-center rounded-xl border border-dashed border-white/12 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-slate-500">
        <Icon size={26} />
      </div>
      <h3 className="mt-4 text-[14px] font-bold text-white">{title}</h3>
      <p className="mt-1.5 max-w-[360px] text-[12px] leading-relaxed text-slate-500">{desc}</p>
    </div>
  );
}

/* ============ 主应用 ============ */
export default function App() {
  const [mcpUrl, setMcpUrl] = useState(DEFAULT_MCP);
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [showPwd, setShowPwd] = useState(false);
  const [token, setToken] = useState("");
  const [usePwdAsToken, setUsePwdAsToken] = useState(false);
  const [status, setStatus] = useState<Status>("disconnected");
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [resources, setResources] = useState<McpResource[]>([]);
  const [prompts, setPrompts] = useState<McpPrompt[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"tools" | "resources" | "prompts" | "logs">("tools");
  const [toolQuery, setToolQuery] = useState("");
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [toolArgs, setToolArgs] = useState("{\n  \n}");
  const [toolCalling, setToolCalling] = useState(false);
  const [toolResult, setToolResult] = useState<any>(null);
  const [resResult, setResResult] = useState<any>(null);
  const [resLoading, setResLoading] = useState<string | null>(null);
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [promptResult, setPromptResult] = useState<any>(null);
  const [promptLoading, setPromptLoading] = useState<string | null>(null);
  const [lastError, setLastError] = useState<{ kind: string; msg: string } | null>(null);

  // 诊断
  const [diagSteps, setDiagSteps] = useState<DiagStep[]>([]);
  const [diag, setDiag] = useState<DiagResult | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

  // OAuth
  const [oauthPhase, setOauthPhase] = useState<"idle" | "preparing" | "waiting" | "exchanging" | "done" | "error">("idle");
  const [oauthMsg, setOauthMsg] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [manualInput, setManualInput] = useState("");
  const popupRef = useRef<Window | null>(null);

  // 回调页模式
  const [cb, setCb] = useState<{ phase: "exchanging" | "success" | "error"; msg: string; token?: string } | null>(null);

  // 修复指南
  const [fixTab, setFixTab] = useState<"py" | "node" | "claude" | "inspector" | "cursor" | "desktop" | "curl">("py");
  const fixRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<McpClient | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((level: LogLevel, message: string, detail?: string) => {
    setLogs((prev) => [...prev.slice(-299), { id: logId++, time: now(), level, message, detail }]);
  }, []);

  useEffect(() => {
    if (logBoxRef.current && activeTab === "logs") {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  const effectiveToken = useMemo(() => {
    if (token.trim()) return token.trim();
    if (usePwdAsToken && password.trim()) return password.trim();
    return null;
  }, [token, usePwdAsToken, password]);

  /* ---------- 连接 ---------- */
  const connect = useCallback(async (tokenOverride?: string | null) => {
    const url = mcpUrl.trim();
    if (!url) {
      addLog("error", "请先填写 MCP 端点地址");
      return;
    }
    const tk = tokenOverride !== undefined ? tokenOverride : effectiveToken;
    const client = new McpClient(url, tk);
    client.onLog = (level, msg, detail) => addLog(level, msg, detail);
    client.onSession = (sid) => setSessionId(sid);
    clientRef.current = client;

    setStatus("connecting");
    setLastError(null);
    setServerInfo(null);
    setTools([]); setResources([]); setPrompts([]);
    setLatency(null);
    addLog("info", `开始连接 ${url}`, tk ? `认证: Bearer ${tk.slice(0, 6)}…(已隐藏)` : "认证: 无(匿名)");

    const t0 = performance.now();
    try {
      const info = await client.initialize();
      setServerInfo(info);
      setLatency(Math.round(performance.now() - t0));

      const [t, r, p] = await Promise.allSettled([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);
      if (t.status === "fulfilled") {
        setTools(t.value);
        addLog("success", `工具列表: ${t.value.length} 个`, t.value.length ? t.value.map((x: McpTool) => x.name).join(", ") : "空");
      } else {
        const m = String(t.reason?.message || t.reason);
        addLog("warn", `tools/list 失败: ${m.split("\n")[0]}`, m);
        if (/session/i.test(m) && !client.sessionId) {
          addLog("warn", "提示:服务端似乎要求 Mcp-Session-Id,但浏览器没读到它 —— 服务端 CORS 需要加 expose_headers=[\"Mcp-Session-Id\"]");
        }
      }
      if (r.status === "fulfilled") {
        setResources(r.value);
        addLog("success", `资源列表: ${r.value.length} 个`);
      } else addLog("warn", `resources/list 失败(服务端可能未实现): ${String(r.reason?.message || r.reason).split("\n")[0]}`);
      if (p.status === "fulfilled") {
        setPrompts(p.value);
        addLog("success", `提示词列表: ${p.value.length} 个`);
      } else addLog("warn", `prompts/list 失败(服务端可能未实现): ${String(p.reason?.message || p.reason).split("\n")[0]}`);

      setStatus("connected");
      setOauthPhase("idle");
      addLog("success", `🎉 连接成功!延迟 ${Math.round(performance.now() - t0)}ms`);
    } catch (e: any) {
      const kind = classifyError(e);
      if (e instanceof McpAuthRequiredError) {
        setStatus("auth_required");
        setLastError({ kind: "auth", msg: tk ? "服务端拒绝了这个 token(401)。password 不是 token,请走 OAuth 授权。" : "服务端要求 OAuth 认证(401)。" });
        addLog("error", tk ? "401:这个 token 无效。注意 password 不是 token,需要通过 OAuth 授权页换取 access_token。" : "401:服务器要求 OAuth 认证。请点击「开始 OAuth 授权」。", e.wwwAuth || "");
      } else {
        setStatus("error");
        const msg = String(e?.message || e);
        setLastError({ kind, msg });
        addLog("error", `连接失败(${kind}): ${msg.split("\n")[0]}`, msg);
      }
    }
  }, [mcpUrl, effectiveToken, addLog]);

  const connectRef = useRef(connect);
  useEffect(() => { connectRef.current = connect; }, [connect]);

  const disconnect = useCallback(() => {
    clientRef.current = null;
    setStatus("disconnected");
    setServerInfo(null);
    setSessionId(null);
    addLog("info", "已断开连接");
  }, [addLog]);

  /* ---------- 诊断 ---------- */
  const doDiagnose = useCallback(async (autoConnectIfOpen = true) => {
    setDiagRunning(true);
    setDiag(null);
    addLog("info", `开始连接诊断: ${mcpUrl}`);
    try {
      const r = await runDiagnostics(mcpUrl.trim(), setDiagSteps);
      setDiag(r);
      const verdictLog: Record<Verdict, [LogLevel, string]> = {
        unreachable: ["error", "诊断结论:隧道不可达 —— 请检查本机 cloudflared 与 MCP 进程是否还在运行"],
        cors_blocked: ["error", "诊断结论:服务端未开启 CORS,浏览器无法直连(隧道本身是通的)"],
        mcp_cors_blocked: ["warn", "诊断结论:OAuth 元数据可读,但 /mcp 端点跨域失败(预检或 401 缺 CORS 头)"],
        auth_required: ["warn", "诊断结论:一切正常,只差 OAuth 授权(401)。password 需在授权页输入。"],
        open: ["success", "诊断结论:端点无需认证,可直接连接"],
        http_error: ["error", `诊断结论:服务端返回 HTTP ${r.mcpStatus}`],
        unknown: ["warn", "诊断结论:未知状态,请查看日志"],
      };
      const [lv, msg] = verdictLog[r.verdict];
      addLog(lv, msg);
      if (r.verdict === "open" && autoConnectIfOpen) {
        setTimeout(() => connectRef.current(null), 300);
      }
      if (r.verdict === "auth_required") setStatus("auth_required");
    } catch (e: any) {
      addLog("error", `诊断过程出错: ${e?.message}`);
    } finally {
      setDiagRunning(false);
    }
  }, [mcpUrl, addLog]);

  /* ---------- OAuth PKCE 授权登录 ---------- */
  const startOAuth = useCallback(async () => {
    setOauthPhase("preparing");
    setOauthMsg("正在发现 OAuth 元数据…");
    setAuthUrl("");
    addLog("info", "开始 OAuth 2.1 PKCE 授权流程");
    try {
      const disc = await discoverOAuth(mcpUrl.trim(), (m, d) => addLog("info", m, d));
      const httpOrigin = isHttpOrigin();
      // 回调地址:当前页面(http/https)或本地回环占位(需手动粘贴)
      const redirectUri = httpOrigin
        ? window.location.origin + window.location.pathname
        : "http://127.0.0.1:19999/callback";
      if (!httpOrigin) addLog("warn", "当前页面不是 http(s) 源,授权后无法自动跳回。授权完成后请把地址栏里的 URL 粘贴到「手动粘贴」框。");

      setOauthMsg("正在动态注册客户端…");
      let clientId = "";
      let clientSecret: string | undefined;
      try {
        const reg = await registerClient(disc.registrationEndpoint!, redirectUri, (m, d) => addLog("info", m, d));
        clientId = reg.client_id;
        clientSecret = reg.client_secret;
      } catch (e: any) {
        const kind = classifyError(e);
        if (kind === "cors") {
          throw new Error("注册客户端时被 CORS 拦截:浏览器无法访问 /oauth/register。需要服务端开启 CORS,或改用原生客户端(见下方修复方案)。");
        }
        addLog("warn", `动态注册失败,尝试使用默认 client_id: ${String(e?.message).split("\n")[0]}`);
        clientId = "tunnel-mcp-console";
      }
      const verifier = randomString(64);
      const challenge = await pkceChallenge(verifier);
      const state = randomString(24);
      const resource = getOrigin(mcpUrl.trim());
      savePkce({
        verifier, state, clientId, clientSecret,
        tokenEndpoint: disc.tokenEndpoint,
        redirectUri, resource, mcpUrl: mcpUrl.trim(), createdAt: Date.now(),
      });
      const url = buildAuthorizeUrl({
        authorizationEndpoint: disc.authorizationEndpoint,
        clientId, redirectUri,
        codeChallenge: challenge, state, resource,
        scope: disc.scopesSupported?.join(" "),
      });
      setAuthUrl(url);
      addLog("info", "授权链接已生成", url);
      addLog("warn", `⚠️ 在授权页面输入 password: ${password}`);
      setOauthPhase("waiting");
      setOauthMsg("已打开授权页面,请在那里输入 password…");
      // 用新窗口打开,避免 iframe 内被 X-Frame-Options 拦截
      const w = window.open(url, "mcp_oauth", "width=520,height=720");
      popupRef.current = w;
      if (!w) {
        setOauthMsg("浏览器拦截了弹窗,请点击下方链接手动打开授权页。");
        addLog("warn", "弹窗被拦截,请手动点击授权链接");
      }
    } catch (e: any) {
      addLog("error", `OAuth 启动失败: ${e?.message}`);
      setOauthPhase("error");
      setOauthMsg(String(e?.message || e));
    }
  }, [mcpUrl, password, addLog]);

  /* ---------- 用授权码换 token(主窗口:手动粘贴 / 回调窗口:自动) ---------- */
  const finishWithCode = useCallback(async (code: string, state?: string, inCallbackTab = false) => {
    const s = loadPkce();
    if (!s) throw new Error("本地没有 PKCE 会话(可能已过期或浏览器隐私模式隔离了存储),请重新点击「开始 OAuth 授权」");
    if (state && s.state !== state) throw new Error("state 不匹配,已终止(请重新发起授权)");
    const tok = await exchangeCode({
      tokenEndpoint: s.tokenEndpoint, code,
      redirectUri: s.redirectUri, clientId: s.clientId, clientSecret: s.clientSecret,
      codeVerifier: s.verifier, resource: s.resource,
    });
    if (!tok.access_token) throw new Error(`响应里没有 access_token: ${JSON.stringify(tok).slice(0, 500)}`);
    clearPkce();
    if (inCallbackTab) {
      try { localStorage.setItem(OAUTH_RESULT_KEY, JSON.stringify({ access_token: tok.access_token, mcpUrl: s.mcpUrl, at: Date.now() })); } catch {}
    }
    return { token: tok.access_token as string, mcpUrl: s.mcpUrl, raw: tok };
  }, []);

  const submitManual = useCallback(async () => {
    const parsed = parseCallbackInput(manualInput);
    if (!parsed) {
      addLog("error", "无法从输入中识别授权码。请粘贴完整的回调 URL(含 ?code=…)或纯 code");
      return;
    }
    setOauthPhase("exchanging");
    setOauthMsg("正在用授权码换取 access_token…");
    try {
      const r = await finishWithCode(parsed.code, parsed.state);
      setToken(r.token);
      setOauthPhase("done");
      setOauthMsg("授权成功,正在连接…");
      addLog("success", "Token 交换成功,自动连接中…");
      setManualInput("");
      setTimeout(() => connectRef.current(r.token), 300);
    } catch (e: any) {
      setOauthPhase("error");
      setOauthMsg(String(e?.message || e));
      addLog("error", `Token 交换失败: ${e?.message}`);
    }
  }, [manualInput, finishWithCode, addLog]);

  /* ---------- 启动:回调模式 or 诊断模式 ---------- */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state") || undefined;
    const err = params.get("error");

    if (err) {
      setCb({ phase: "error", msg: `授权被拒绝: ${err} ${params.get("error_description") || ""}` });
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (code) {
      setCb({ phase: "exchanging", msg: "收到授权码,正在换取 access_token…" });
      window.history.replaceState({}, "", window.location.pathname);
      (async () => {
        try {
          const r = await finishWithCode(code, state, true);
          if (r.mcpUrl) setMcpUrl(r.mcpUrl);
          setToken(r.token);
          setCb({ phase: "success", msg: "授权成功!token 已回传给原窗口。", token: r.token });
          addLog("success", "回调窗口:token 交换成功");
          // 如果是弹窗打开的,1.5 秒后自动关闭
          if (window.opener) setTimeout(() => { try { window.close(); } catch {} }, 1800);
        } catch (e: any) {
          setCb({ phase: "error", msg: String(e?.message || e) });
        }
      })();
      return;
    }

    // 主窗口:欢迎 + 自动诊断
    addLog("info", "欢迎使用 Tunnel MCP 控制台 🚇");
    addLog("info", `隧道: ${DEFAULT_TUNNEL}`);
    addLog("info", `MCP 端点: ${DEFAULT_MCP}`);
    addLog("info", "已知服务端信息:OAuth 端点 /oauth/authorize、/oauth/token、/oauth/register,仅支持 authorization_code");
    const t = setTimeout(() => doDiagnose(true), 500);

    // 监听回调窗口回传的 token
    const onStorage = (e: StorageEvent) => {
      if (e.key !== OAUTH_RESULT_KEY || !e.newValue) return;
      try {
        const r = JSON.parse(e.newValue);
        if (!r.access_token || Date.now() - (r.at || 0) > 5 * 60 * 1000) return;
        localStorage.removeItem(OAUTH_RESULT_KEY);
        setToken(r.access_token);
        setOauthPhase("done");
        setOauthMsg("授权成功,正在连接…");
        addLog("success", "收到回调窗口回传的 access_token,自动连接中…");
        try { popupRef.current?.close(); } catch {}
        setTimeout(() => connectRef.current(r.access_token), 300);
      } catch {}
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearTimeout(t);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 工具调用 ---------- */
  const openTool = (t: McpTool) => {
    setSelectedTool(t);
    setToolResult(null);
    try {
      const props = t.inputSchema?.properties || {};
      const tmpl: any = {};
      for (const [k, v] of Object.entries(props)) {
        const vv: any = v as any;
        if (vv.default !== undefined) tmpl[k] = vv.default;
        else if (vv.type === "string") tmpl[k] = "";
        else if (vv.type === "number" || vv.type === "integer") tmpl[k] = 0;
        else if (vv.type === "boolean") tmpl[k] = false;
        else if (vv.type === "array") tmpl[k] = [];
        else if (vv.type === "object") tmpl[k] = {};
        else tmpl[k] = "";
      }
      setToolArgs(JSON.stringify(tmpl, null, 2));
    } catch {
      setToolArgs("{}");
    }
  };

  const callSelectedTool = async () => {
    if (!selectedTool || !clientRef.current) return;
    let args: any = {};
    try {
      args = toolArgs.trim() ? JSON.parse(toolArgs) : {};
    } catch (e: any) {
      addLog("error", `参数不是合法 JSON: ${e?.message}`);
      setToolResult({ _error: `参数 JSON 解析失败: ${e?.message}` });
      return;
    }
    setToolCalling(true);
    setToolResult(null);
    addLog("info", `调用工具 ${selectedTool.name}`, JSON.stringify(args, null, 2));
    try {
      const r = await clientRef.current.callTool(selectedTool.name, args);
      setToolResult(r);
      addLog("success", `工具 ${selectedTool.name} 执行成功`);
    } catch (e: any) {
      setToolResult({ _error: String(e?.message || e) });
      addLog("error", `工具 ${selectedTool.name} 执行失败: ${String(e?.message).split("\n")[0]}`);
    } finally {
      setToolCalling(false);
    }
  };

  const readResource = async (uri: string) => {
    if (!clientRef.current) return;
    setResLoading(uri);
    setResResult(null);
    try {
      const r = await clientRef.current.readResource(uri);
      setResResult(r);
      addLog("success", `资源读取成功: ${uri}`);
    } catch (e: any) {
      setResResult({ _error: String(e?.message || e) });
      addLog("error", `资源读取失败: ${String(e?.message).split("\n")[0]}`);
    } finally {
      setResLoading(null);
    }
  };

  const getPrompt = async (p: McpPrompt) => {
    if (!clientRef.current) return;
    setPromptLoading(p.name);
    setPromptResult(null);
    const args: any = {};
    (p.arguments || []).forEach((a) => {
      if (promptArgs[`${p.name}:${a.name}`] !== undefined) args[a.name] = promptArgs[`${p.name}:${a.name}`];
    });
    try {
      const r = await clientRef.current.getPrompt(p.name, args);
      setPromptResult(r);
      addLog("success", `提示词获取成功: ${p.name}`);
    } catch (e: any) {
      setPromptResult({ _error: String(e?.message || e) });
      addLog("error", `提示词获取失败: ${String(e?.message).split("\n")[0]}`);
    } finally {
      setPromptLoading(null);
    }
  };

  const filteredTools = useMemo(() => {
    if (!toolQuery.trim()) return tools;
    const q = toolQuery.toLowerCase();
    return tools.filter((t) => t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
  }, [tools, toolQuery]);

  const statusText: Record<Status, string> = {
    disconnected: "未连接",
    connecting: "连接中…",
    connected: "已连接",
    auth_required: "需要授权",
    error: "连接失败",
  };

  const scrollToFix = (tab?: typeof fixTab) => {
    if (tab) setFixTab(tab);
    fixRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* ---------- 判定文案 ---------- */
  const verdictUi = useMemo(() => {
    if (!diag) return null;
    const v = diag.verdict;
    const base = { cls: "", icon: Info, title: "", desc: "", primary: null as null | { label: string; onClick: () => void; icon: any }, secondary: null as null | { label: string; onClick: () => void } };
    switch (v) {
      case "unreachable":
        return { ...base, cls: "border-rose-400/30 bg-rose-500/10", icon: XCircle, title: "隧道不可达", desc: "浏览器完全连不上这个地址。trycloudflare 隧道是临时的:请到本机终端确认 cloudflared 和 coding-tools-mcp 两个进程都还在运行。如果重启过隧道,地址会变,需要把新地址填到上面的输入框。", primary: { label: "重新诊断", onClick: () => doDiagnose(), icon: RefreshCw }, secondary: { label: "查看原生客户端方案", onClick: () => scrollToFix("claude") } };
      case "cors_blocked":
        return { ...base, cls: "border-amber-400/30 bg-amber-500/10", icon: TriangleAlert, title: "服务端没开 CORS,浏览器被拦住了", desc: "服务器是有响应的(隧道正常、密码也没问题),但响应里缺少 Access-Control-Allow-Origin 头,浏览器出于安全策略拒绝把内容交给网页。这就是「连不上」的原因。两条路:① 在 coding-tools-mcp 服务端加 CORS 中间件(下方有现成代码);② 用 Claude Code / Cursor / MCP Inspector 这类原生客户端,它们不受 CORS 限制。", primary: { label: "查看服务端修复代码", onClick: () => scrollToFix("py"), icon: Code2 }, secondary: { label: "重新诊断", onClick: () => doDiagnose() } };
      case "mcp_cors_blocked":
        return { ...base, cls: "border-amber-400/30 bg-amber-500/10", icon: TriangleAlert, title: "元数据能读,但 /mcp 端点跨域失败", desc: "通常是服务端没处理 OPTIONS 预检请求,或者 401 响应没带 CORS 头(认证中间件排在 CORS 中间件前面)。你可以先试试 OAuth 授权 —— 带上有效 token 后请求可能就通了;不行的话按下方代码修一下服务端。", primary: { label: "开始 OAuth 授权", onClick: startOAuth, icon: ShieldCheck }, secondary: { label: "查看服务端修复代码", onClick: () => scrollToFix("py") } };
      case "auth_required":
        return { ...base, cls: "border-cyan-400/30 bg-cyan-500/10", icon: ShieldCheck, title: "链路一切正常,只差 OAuth 授权", desc: "服务端返回 401 —— 这正是「连不上」的原因:那串 password 不是 token,不能直接塞进请求头。它是在 /oauth/authorize 登录页里输入的密码。点击下方按钮 → 在弹出的页面输入 password → 系统自动换取 access_token 并连接。", primary: { label: "开始 OAuth 授权", onClick: startOAuth, icon: ShieldCheck }, secondary: null };
      case "open":
        return { ...base, cls: "border-emerald-400/30 bg-emerald-500/10", icon: CircleCheck, title: "端点无需认证,可以直接连", desc: "服务端对未认证请求也返回了成功,正在自动连接…", primary: { label: "一键连接", onClick: () => connect(null), icon: Zap }, secondary: null };
      case "http_error":
        return { ...base, cls: "border-rose-400/30 bg-rose-500/10", icon: XCircle, title: `服务端返回 HTTP ${diag.mcpStatus}`, desc: "隧道和 CORS 都正常,但 MCP 端点返回了异常状态。请展开下方诊断详情查看响应体,或到「日志」标签页查看完整信息。常见:404 = 路径不对(确认是 /mcp);406 = Accept 头不被接受;500 = 服务端崩了。", primary: { label: "重新诊断", onClick: () => doDiagnose(), icon: RefreshCw }, secondary: { label: "查看日志", onClick: () => setActiveTab("logs") } };
      default:
        return { ...base, cls: "border-white/10 bg-white/5", icon: Info, title: "状态未知", desc: "请查看下方详情与日志。", primary: { label: "重新诊断", onClick: () => doDiagnose(), icon: RefreshCw }, secondary: null };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag, startOAuth, connect, doDiagnose]);

  /* ======================= 回调窗口界面 ======================= */
  if (cb) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="pointer-events-none fixed inset-0 -z-10">
          <div className="absolute inset-0 bg-[#04060c]" />
          <div className="grid-bg absolute inset-0" />
          <div className="absolute left-1/2 top-1/3 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-cyan-500/12 blur-[140px]" />
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="glass w-full max-w-md rounded-3xl border border-white/10 p-8 text-center">
          {cb.phase === "exchanging" && <Loader2 size={40} className="mx-auto animate-spin text-cyan-300" />}
          {cb.phase === "success" && <PartyPopper size={40} className="mx-auto text-emerald-300" />}
          {cb.phase === "error" && <XCircle size={40} className="mx-auto text-rose-300" />}
          <h1 className="mt-4 text-xl font-bold text-white">
            {cb.phase === "exchanging" ? "正在完成授权…" : cb.phase === "success" ? "授权成功 🎉" : "授权失败"}
          </h1>
          <p className="mt-2 break-words text-[13px] leading-relaxed text-slate-400">{cb.msg}</p>
          {cb.phase === "success" && (
            <div className="mt-6 space-y-3">
              <p className="text-[12px] text-slate-500">{window.opener ? "这个窗口会自动关闭。若没有关闭,可手动关闭并回到原窗口。" : "原窗口若已自动连接,可直接关闭此页。"}</p>
              <button
                onClick={() => { setCb(null); setTimeout(() => connectRef.current(cb.token || null), 200); }}
                className="w-full rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 px-4 py-3 text-sm font-bold text-black"
              >
                在此窗口直接连接
              </button>
              <div className="rounded-xl border border-white/10 bg-black/40 p-3 text-left">
                <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">access_token <CopyBtn text={cb.token || ""} /></div>
                <div className="code-font break-all text-[11px] text-emerald-200">{(cb.token || "").slice(0, 80)}{(cb.token || "").length > 80 ? "…" : ""}</div>
              </div>
            </div>
          )}
          {cb.phase === "error" && (
            <button onClick={() => setCb(null)} className="mt-6 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-semibold text-white">返回控制台</button>
          )}
        </motion.div>
      </div>
    );
  }

  /* ======================= 主界面 ======================= */
  return (
    <div className="relative min-h-full">
      {/* 背景 */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[#04060c]" />
        <div className="grid-bg absolute inset-0" />
        <div className="absolute -top-40 left-1/4 h-[420px] w-[620px] rounded-full bg-cyan-500/12 blur-[140px]" />
        <div className="absolute top-20 right-0 h-[380px] w-[480px] rounded-full bg-violet-600/12 blur-[140px]" />
        <div className="absolute bottom-0 left-0 h-[300px] w-[420px] rounded-full bg-emerald-500/8 blur-[120px]" />
      </div>

      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#04060c]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 via-sky-500 to-violet-600 shadow-lg shadow-cyan-500/25">
            <PlugZap size={20} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-bold tracking-tight text-white sm:text-base">
              Tunnel MCP 控制台 <span className="ml-1 hidden rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300 sm:inline">v1.1</span>
            </h1>
            <p className="code-font truncate text-[11px] text-slate-500">{mcpUrl}</p>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            {latency !== null && status === "connected" && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300">
                <Activity size={13} className="text-emerald-400" /> {latency}ms
              </span>
            )}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-200">
              <StatusDot status={status} /> {statusText[status]}
            </span>
          </div>
          <button onClick={() => scrollToFix()} className="hidden items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300 transition hover:border-white/25 hover:text-white sm:inline-flex">
            <LifeBuoy size={13} /> 修复方案
          </button>
        </div>
      </header>

      {/* 隧道横幅 */}
      <div className="mx-auto max-w-[1440px] px-4 pt-5 sm:px-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-r from-cyan-500/10 via-sky-500/8 to-violet-500/10 p-4 sm:p-5">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-cyan-400/15 blur-3xl" />
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-300"><Radio size={18} /></div>
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                  你的 Cloudflare 隧道
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${status === "connected" ? "bg-emerald-400/15 text-emerald-300" : status === "connecting" ? "bg-amber-400/15 text-amber-300" : status === "auth_required" ? "bg-orange-400/15 text-orange-300" : "bg-white/8 text-slate-300"}`}>
                    <StatusDot status={status} /> {statusText[status]}
                  </span>
                </div>
                <div className="code-font mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-400">
                  <span className="inline-flex items-center gap-1.5"><Globe size={12} className="text-cyan-400" />{DEFAULT_TUNNEL}</span>
                  <span className="inline-flex items-center gap-1.5"><Lock size={12} className="text-amber-400" />OAuth 2.1 · PKCE · /oauth/authorize</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
              {status === "connected" ? (
                <button onClick={disconnect} className="inline-flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-sm font-medium text-rose-300 transition hover:bg-rose-500/20">
                  <Unplug size={16} /> 断开连接
                </button>
              ) : (
                <>
                  <button
                    onClick={startOAuth} disabled={oauthPhase === "preparing" || oauthPhase === "exchanging"}
                    className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 px-5 py-2.5 text-sm font-bold text-black shadow-lg shadow-cyan-500/30 transition hover:shadow-cyan-400/40 disabled:opacity-60"
                  >
                    {oauthPhase === "preparing" || oauthPhase === "exchanging" ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} className="transition group-hover:scale-110" />}
                    开始 OAuth 授权
                  </button>
                  <button onClick={() => connect()} disabled={status === "connecting"} className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:border-white/25 disabled:opacity-60">
                    {status === "connecting" ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />} 直接连接
                  </button>
                </>
              )}
              <button onClick={() => doDiagnose(false)} disabled={diagRunning} className="inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/5 px-4 py-2.5 text-sm text-slate-200 transition hover:border-white/25 disabled:opacity-60">
                {diagRunning ? <Loader2 size={15} className="animate-spin" /> : <Stethoscope size={15} />} 重新诊断
              </button>
            </div>
          </div>
        </motion.div>
      </div>

      {/* 主体 */}
      <main className="mx-auto grid max-w-[1440px] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[380px_1fr]">
        {/* ===== 左列 ===== */}
        <div className="space-y-4">
          {/* 连接设置 */}
          <motion.section initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 }} className="glass rounded-2xl border border-white/10 p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white"><Server size={15} className="text-cyan-400" /> 连接设置</h2>
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-400">MCP 端点 URL <CopyBtn text={mcpUrl} /></label>
                <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://xxx.trycloudflare.com/mcp" spellCheck={false} className="code-font w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-[12.5px] text-slate-100 placeholder:text-slate-600" />
              </div>
              <div>
                <label className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-400">
                  <span className="inline-flex items-center gap-1"><KeyRound size={11} className="text-amber-400" /> OAuth authorize password(在授权页输入)</span>
                  <span className="flex items-center gap-1">
                    <button onClick={() => setShowPwd(!showPwd)} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:text-white">{showPwd ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                    <CopyBtn text={password} />
                  </span>
                </label>
                <input type={showPwd ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} spellCheck={false} className="code-font w-full rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-[12.5px] text-amber-100 placeholder:text-slate-600" />
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">⚠️ 这不是 Token。它只在 <span className="code-font text-slate-400">/oauth/authorize</span> 登录页里使用,换回来的 access_token 才能连 MCP。</p>
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-slate-400">Access Token(OAuth 成功后自动填入,也可手动粘贴)</label>
                <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={2} spellCheck={false} placeholder="授权成功后自动出现在这里…" className="code-font w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-[12px] text-slate-100 placeholder:text-slate-600" />
              </div>
              <details className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
                <summary className="cursor-pointer text-[11.5px] text-slate-400">高级选项</summary>
                <label className="mt-2 flex cursor-pointer items-center justify-between">
                  <span className="text-[12px] text-slate-300">把 password 直接当 Bearer Token 试试(通常会 401)</span>
                  <button onClick={() => setUsePwdAsToken(!usePwdAsToken)} className={`relative h-5 w-9 shrink-0 rounded-full transition ${usePwdAsToken ? "bg-cyan-400" : "bg-white/15"}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${usePwdAsToken ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </label>
              </details>
              {sessionId && (
                <div className="code-font rounded-xl border border-white/8 bg-black/40 px-3 py-2 text-[11px] text-slate-400">Session: <span className="text-cyan-300">{sessionId}</span></div>
              )}
            </div>
          </motion.section>

          {/* OAuth 面板 */}
          <motion.section initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }} className="glass rounded-2xl border border-violet-400/20 p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white"><ShieldCheck size={15} className="text-violet-400" /> OAuth 授权(PKCE)</h2>
            <ol className="mt-3 space-y-2 text-[12px] text-slate-400">
              {[
                ["1", "点击「开始 OAuth 授权」,弹出服务端登录页"],
                ["2", "在登录页粘贴上面的 password 并提交"],
                ["3", "页面跳回本站,自动换取 token 并连接"],
              ].map(([n, t]) => (
                <li key={n} className="flex items-start gap-2"><span className="code-font mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-violet-400/20 text-[10px] font-bold text-violet-200">{n}</span>{t}</li>
              ))}
            </ol>
            <button onClick={startOAuth} disabled={oauthPhase === "preparing" || oauthPhase === "exchanging"} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2.5 text-[13px] font-bold text-white shadow-lg shadow-violet-500/25 transition hover:shadow-violet-400/40 disabled:opacity-60">
              {oauthPhase === "preparing" || oauthPhase === "exchanging" ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              {oauthPhase === "preparing" ? "准备中…" : oauthPhase === "exchanging" ? "换取 token…" : oauthPhase === "waiting" ? "重新打开授权页" : "开始 OAuth 授权"}
            </button>

            <AnimatePresence>
              {oauthPhase !== "idle" && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <div className={`mt-3 rounded-xl border p-3 text-[12px] leading-relaxed ${oauthPhase === "error" ? "border-rose-400/30 bg-rose-500/10 text-rose-200" : oauthPhase === "done" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-violet-400/25 bg-violet-500/10 text-violet-100"}`}>
                    <div className="flex items-start gap-2">
                      {oauthPhase === "error" ? <XCircle size={14} className="mt-0.5 shrink-0" /> : oauthPhase === "done" ? <CircleCheck size={14} className="mt-0.5 shrink-0" /> : <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
                      <span className="break-words">{oauthMsg}</span>
                    </div>
                    {oauthPhase === "waiting" && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center justify-between rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2">
                          <span className="text-[11px] text-amber-200">在授权页输入这个 password →</span>
                          <CopyBtn text={password} label="复制 password" />
                        </div>
                        {authUrl && (
                          <a href={authUrl} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[12px] font-medium text-white hover:bg-white/10">
                            <ExternalLink size={13} /> 手动打开授权页
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 手动粘贴兜底 */}
            <details className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2" open={oauthPhase === "waiting" && !isHttpOrigin()}>
              <summary className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-400"><ClipboardPaste size={12} /> 没自动跳回?手动粘贴回调 URL / 授权码</summary>
              <div className="mt-2 space-y-2">
                <p className="text-[11px] leading-relaxed text-slate-500">授权后浏览器地址栏会变成 <span className="code-font">…?code=xxx&state=yyy</span>(即使页面打不开也没关系),把整个地址复制到这里:</p>
                <textarea value={manualInput} onChange={(e) => setManualInput(e.target.value)} rows={2} spellCheck={false} placeholder="http://…/callback?code=…&state=…" className="code-font w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11.5px] text-slate-100 placeholder:text-slate-600" />
                <button onClick={submitManual} disabled={!manualInput.trim() || oauthPhase === "exchanging"} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-[12px] font-semibold text-violet-100 hover:bg-violet-500/25 disabled:opacity-50">
                  <ArrowRight size={13} /> 用这个授权码换 token 并连接
                </button>
              </div>
            </details>
          </motion.section>

          {/* 服务器信息 */}
          <motion.section initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 }} className="glass rounded-2xl border border-white/10 p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white"><Sparkles size={15} className="text-violet-400" /> 服务器信息</h2>
            {serverInfo ? (
              <div className="mt-3 space-y-2 text-[12px]">
                <div className="flex justify-between rounded-lg bg-white/[0.04] px-3 py-2"><span className="text-slate-500">名称</span><span className="font-semibold text-white">{serverInfo.name}</span></div>
                <div className="flex justify-between rounded-lg bg-white/[0.04] px-3 py-2"><span className="text-slate-500">版本</span><span className="code-font text-slate-200">{serverInfo.version}</span></div>
                <div className="flex justify-between rounded-lg bg-white/[0.04] px-3 py-2"><span className="text-slate-500">协议</span><span className="code-font text-cyan-300">{serverInfo.protocolVersion}</span></div>
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/8 p-2.5 text-center"><div className="text-xl font-bold text-cyan-300">{tools.length}</div><div className="text-[10px] text-slate-500">工具</div></div>
                  <div className="rounded-xl border border-violet-400/20 bg-violet-400/8 p-2.5 text-center"><div className="text-xl font-bold text-violet-300">{resources.length}</div><div className="text-[10px] text-slate-500">资源</div></div>
                  <div className="rounded-xl border border-amber-400/20 bg-amber-400/8 p-2.5 text-center"><div className="text-xl font-bold text-amber-300">{prompts.length}</div><div className="text-[10px] text-slate-500">提示词</div></div>
                </div>
                {serverInfo.instructions && <p className="rounded-lg border border-white/8 bg-black/30 p-2.5 text-[11px] leading-relaxed text-slate-400">{serverInfo.instructions}</p>}
                {serverInfo.capabilities && (
                  <details><summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300">查看 capabilities</summary><div className="mt-2"><JsonView data={serverInfo.capabilities} maxHeight="160px" /></div></details>
                )}
                {token && (
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">带 token 的客户端配置 <CopyBtn text={tokenConfig(mcpUrl, token)} /></div>
                    <JsonView data={tokenConfig(mcpUrl, token)} maxHeight="140px" />
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-white/12 p-5 text-center">
                <Server size={22} className="mx-auto text-slate-600" />
                <p className="mt-2 text-[12px] text-slate-500">尚未连接<br />连接成功后这里会显示服务详情</p>
              </div>
            )}
          </motion.section>
        </div>

        {/* ===== 右列 ===== */}
        <div className="space-y-4">
          {/* 诊断面板(未连接时显示) */}
          {status !== "connected" && (
            <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="glass rounded-2xl border border-white/10 p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-bold text-white"><Stethoscope size={15} className="text-cyan-400" /> 为什么连不上?—— 自动诊断</h2>
                <button onClick={() => doDiagnose(false)} disabled={diagRunning} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-300 hover:text-white disabled:opacity-50">
                  {diagRunning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 重新诊断
                </button>
              </div>

              {/* 判定 */}
              <AnimatePresence mode="wait">
                {verdictUi && !diagRunning && (
                  <motion.div key={diag?.verdict} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`mt-3 rounded-xl border p-4 ${verdictUi.cls}`}>
                    <div className="flex items-start gap-3">
                      <verdictUi.icon size={20} className="mt-0.5 shrink-0 text-white" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[14px] font-bold text-white">{verdictUi.title}</h3>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-slate-200/90">{verdictUi.desc}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {verdictUi.primary && (
                            <button onClick={verdictUi.primary.onClick} className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-[12.5px] font-bold text-black shadow transition hover:bg-slate-100">
                              <verdictUi.primary.icon size={14} /> {verdictUi.primary.label}
                            </button>
                          )}
                          {verdictUi.secondary && (
                            <button onClick={verdictUi.secondary.onClick} className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-white/15">
                              {verdictUi.secondary.label}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {lastError && (
                <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/8 p-3 text-[12px] text-rose-200">
                  <div className="flex items-center gap-2 font-semibold"><TriangleAlert size={13} /> 最近一次连接错误({lastError.kind})</div>
                  <pre className="code-font mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-rose-100/80">{lastError.msg}</pre>
                </div>
              )}

              {/* 步骤 */}
              <div className="mt-3 space-y-1.5">
                {(diagSteps.length ? diagSteps : [
                  { id: "reach", title: "隧道可达性(Cloudflare 边缘 → 你的本机)", state: "pending" as const },
                  { id: "cors", title: "浏览器跨域(CORS)能否读取服务端响应", state: "pending" as const },
                  { id: "meta", title: "OAuth 授权服务器元数据", state: "pending" as const },
                  { id: "mcp", title: "MCP 端点握手(POST initialize,未带 token)", state: "pending" as const },
                ]).map((s, i) => (
                  <div key={s.id} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="code-font w-4 text-[10px] text-slate-600">{i + 1}</span>
                      <DiagIcon state={s.state} />
                      <span className="text-[12.5px] font-medium text-slate-200">{s.title}</span>
                    </div>
                    {s.detail && <p className="code-font mt-1.5 whitespace-pre-wrap pl-[42px] text-[11px] leading-relaxed text-slate-400">{s.detail}</p>}
                    {s.raw && (
                      <details className="mt-1 pl-[42px]"><summary className="cursor-pointer text-[10.5px] text-slate-500 hover:text-slate-300">原始响应</summary>
                        <pre className="code-font mt-1 max-h-48 overflow-auto rounded-lg bg-black/50 p-2 text-[10.5px] text-slate-400">{s.raw}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-slate-500">
                已知事实(服务端探测):授权端点 <span className="code-font text-slate-400">/oauth/authorize</span>,令牌端点 <span className="code-font text-slate-400">/oauth/token</span>,注册端点 <span className="code-font text-slate-400">/oauth/register</span>;仅支持 <span className="code-font text-slate-400">authorization_code</span> + PKCE S256。
              </p>
            </motion.section>
          )}

          {/* 工作区 */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="glass flex min-h-[480px] flex-col overflow-hidden rounded-2xl border border-white/10">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-white/8 p-2">
              {([
                { id: "tools", label: "工具", icon: Wrench, count: tools.length, color: "text-cyan-300" },
                { id: "resources", label: "资源", icon: Database, count: resources.length, color: "text-violet-300" },
                { id: "prompts", label: "提示词", icon: MessagesSquare, count: prompts.length, color: "text-amber-300" },
                { id: "logs", label: "日志", icon: TerminalSquare, count: logs.length, color: "text-emerald-300" },
              ] as const).map((t) => (
                <button key={t.id} onClick={() => setActiveTab(t.id)} className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium transition ${activeTab === t.id ? "bg-white/10 text-white shadow" : "text-slate-500 hover:bg-white/5 hover:text-slate-200"}`}>
                  <t.icon size={15} className={activeTab === t.id ? t.color : ""} />
                  {t.label}
                  <span className={`code-font rounded-full px-1.5 py-0.5 text-[10px] ${activeTab === t.id ? "bg-white/15 text-white" : "bg-white/5 text-slate-500"}`}>{t.count}</span>
                </button>
              ))}
              <div className="ml-auto hidden shrink-0 items-center gap-2 pr-2 sm:flex">
                <button onClick={() => { setLogs([]); addLog("info", "日志已清空"); }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-white"><Trash2 size={12} /> 清空</button>
                <button onClick={() => {
                  const blob = new Blob([logs.map((l) => `[${l.time}] [${l.level}] ${l.message}${l.detail ? "\n" + l.detail : ""}`).join("\n\n")], { type: "text/plain" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `mcp-logs-${Date.now()}.txt`; a.click();
                }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-white"><Download size={12} /> 导出</button>
              </div>
            </div>

            <div className="flex-1 p-3 sm:p-4">
              <AnimatePresence mode="wait">
                {activeTab === "tools" && (
                  <motion.div key="tools" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    {status !== "connected" ? (
                      <EmptyState icon={Wrench} title="还没有工具" desc="完成上方的 OAuth 授权并连接成功后,服务端的工具会自动出现在这里" />
                    ) : tools.length === 0 ? (
                      <EmptyState icon={ListTree} title="服务端没有暴露任何工具" desc="连接是成功的,但 tools/list 返回为空。请检查服务端 coding-tools-mcp 的配置" />
                    ) : (
                      <div className="grid gap-3 xl:grid-cols-2">
                        <div className="space-y-2">
                          <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                            <input value={toolQuery} onChange={(e) => setToolQuery(e.target.value)} placeholder={`搜索 ${tools.length} 个工具…`} className="w-full rounded-xl border border-white/10 bg-black/40 py-2.5 pl-9 pr-3 text-[13px] text-white placeholder:text-slate-600" />
                          </div>
                          <div className="max-h-[560px] space-y-2 overflow-auto pr-1">
                            {filteredTools.map((t) => (
                              <button key={t.name} onClick={() => openTool(t)} className={`w-full rounded-xl border p-3 text-left transition ${selectedTool?.name === t.name ? "border-cyan-400/50 bg-cyan-400/8 shadow-lg shadow-cyan-500/10" : "border-white/8 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"}`}>
                                <div className="flex items-center gap-2">
                                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cyan-400/12 text-cyan-300"><Wrench size={13} /></span>
                                  <span className="code-font truncate text-[13px] font-bold text-white">{t.name}</span>
                                  <ChevronRight size={14} className="ml-auto shrink-0 text-slate-600" />
                                </div>
                                {t.description && <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-slate-400">{t.description}</p>}
                              </button>
                            ))}
                            {filteredTools.length === 0 && <p className="py-6 text-center text-[12px] text-slate-500">没有匹配「{toolQuery}」的工具</p>}
                          </div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                          {!selectedTool ? (
                            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
                              <Braces size={28} className="text-slate-700" />
                              <p className="mt-3 text-[13px] text-slate-500">← 点击左侧工具<br />在这里填写参数并执行</p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <h3 className="code-font text-[14px] font-bold text-white">{selectedTool.name}</h3>
                                  {selectedTool.description && <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{selectedTool.description}</p>}
                                </div>
                                <button onClick={() => { setSelectedTool(null); setToolResult(null); }} className="rounded-lg border border-white/10 p-1.5 text-slate-500 hover:text-white"><X size={14} /></button>
                              </div>
                              {selectedTool.inputSchema?.properties && (
                                <div className="flex flex-wrap gap-1.5">
                                  {Object.entries(selectedTool.inputSchema.properties).map(([k, v]: any) => (
                                    <span key={k} className="code-font inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10.5px] text-slate-300">
                                      {k}<span className="text-slate-600">:{v?.type || "any"}</span>
                                      {selectedTool.inputSchema?.required?.includes(k) && <span className="text-rose-400">*</span>}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div>
                                <div className="mb-1.5 flex items-center justify-between">
                                  <label className="text-[11px] font-medium text-slate-400">参数 (JSON)</label>
                                  <button onClick={() => { try { setToolArgs(JSON.stringify(JSON.parse(toolArgs), null, 2)); } catch {} }} className="text-[11px] text-cyan-300 hover:text-cyan-200">格式化</button>
                                </div>
                                <textarea value={toolArgs} onChange={(e) => setToolArgs(e.target.value)} rows={7} spellCheck={false} className="code-font w-full resize-y rounded-xl border border-white/10 bg-black/60 p-3 text-[12px] leading-relaxed text-emerald-100" />
                              </div>
                              <button onClick={callSelectedTool} disabled={toolCalling} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-500 px-4 py-2.5 text-[13px] font-bold text-black shadow-lg shadow-emerald-500/20 transition hover:shadow-emerald-400/30 disabled:opacity-60">
                                {toolCalling ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                                {toolCalling ? "执行中…" : `执行 ${selectedTool.name}`}
                              </button>
                              {toolResult && (<div><label className="mb-1.5 block text-[11px] font-medium text-slate-400">执行结果</label><JsonView data={toolResult} maxHeight="280px" /></div>)}
                              <details><summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-300">查看 inputSchema</summary><div className="mt-2"><JsonView data={selectedTool.inputSchema || {}} maxHeight="180px" /></div></details>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === "resources" && (
                  <motion.div key="res" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    {status !== "connected" ? (
                      <EmptyState icon={Database} title="还没有资源" desc="连接成功后,服务端的 resources 会列在这里" />
                    ) : resources.length === 0 ? (
                      <EmptyState icon={Database} title="服务端没有暴露资源" desc="resources/list 返回为空,这是正常的——很多 MCP 服务只提供 tools" />
                    ) : (
                      <div className="grid gap-3 xl:grid-cols-2">
                        <div className="max-h-[560px] space-y-2 overflow-auto pr-1">
                          {resources.map((r) => (
                            <div key={r.uri} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                              <div className="flex items-center gap-2">
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-400/12 text-violet-300"><Database size={13} /></span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] font-bold text-white">{r.name}</div>
                                  <div className="code-font truncate text-[11px] text-slate-500">{r.uri}</div>
                                </div>
                                <button onClick={() => readResource(r.uri)} disabled={resLoading === r.uri} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-500/20 px-3 py-1.5 text-[12px] font-medium text-violet-200 transition hover:bg-violet-500/30 disabled:opacity-60">
                                  {resLoading === r.uri ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 读取
                                </button>
                              </div>
                              {r.description && <p className="mt-1.5 text-[11.5px] text-slate-400">{r.description}</p>}
                            </div>
                          ))}
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                          <label className="mb-2 block text-[11px] font-medium text-slate-400">读取结果</label>
                          {resResult ? <JsonView data={resResult} maxHeight="480px" /> : <p className="py-16 text-center text-[12px] text-slate-600">点击左侧「读取」查看资源内容</p>}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === "prompts" && (
                  <motion.div key="prompts" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    {status !== "connected" ? (
                      <EmptyState icon={MessagesSquare} title="还没有提示词" desc="连接成功后,服务端的 prompts 会列在这里" />
                    ) : prompts.length === 0 ? (
                      <EmptyState icon={MessagesSquare} title="服务端没有暴露提示词" desc="prompts/list 返回为空,这是正常的——很多 MCP 服务只提供 tools" />
                    ) : (
                      <div className="grid gap-3 xl:grid-cols-2">
                        <div className="max-h-[560px] space-y-2 overflow-auto pr-1">
                          {prompts.map((p) => (
                            <div key={p.name} className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
                              <div className="flex items-center gap-2">
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-400/12 text-amber-300"><MessagesSquare size={13} /></span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[13px] font-bold text-white">{p.name}</div>
                                  {p.description && <div className="truncate text-[11px] text-slate-500">{p.description}</div>}
                                </div>
                                <button onClick={() => getPrompt(p)} disabled={promptLoading === p.name} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500/20 px-3 py-1.5 text-[12px] font-medium text-amber-200 transition hover:bg-amber-500/30 disabled:opacity-60">
                                  {promptLoading === p.name ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 获取
                                </button>
                              </div>
                              {(p.arguments || []).length > 0 && (
                                <div className="mt-2 space-y-1.5">
                                  {(p.arguments || []).map((a) => (
                                    <div key={a.name} className="flex items-center gap-2">
                                      <span className="code-font w-24 shrink-0 truncate text-[11px] text-slate-400">{a.name}{a.required && <span className="text-rose-400">*</span>}</span>
                                      <input value={promptArgs[`${p.name}:${a.name}`] || ""} onChange={(e) => setPromptArgs((s) => ({ ...s, [`${p.name}:${a.name}`]: e.target.value }))} placeholder={a.description || a.name} className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white placeholder:text-slate-600" />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                          <label className="mb-2 block text-[11px] font-medium text-slate-400">提示词内容</label>
                          {promptResult ? <JsonView data={promptResult} maxHeight="480px" /> : <p className="py-16 text-center text-[12px] text-slate-600">点击左侧「获取」查看提示词渲染结果</p>}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {activeTab === "logs" && (
                  <motion.div key="logs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <div ref={logBoxRef} className="max-h-[600px] space-y-1.5 overflow-auto rounded-xl border border-white/8 bg-black/50 p-3">
                      {logs.length === 0 && <p className="py-10 text-center text-[12px] text-slate-600">暂无日志</p>}
                      {logs.map((l) => {
                        const S = levelStyle[l.level];
                        return (
                          <div key={l.id} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                            <div className="flex items-center gap-2">
                              <S.icon size={13} className={`${S.color} shrink-0`} />
                              <span className="code-font shrink-0 text-[10.5px] text-slate-600">{l.time}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${S.color} bg-white/5`}>{l.level}</span>
                              <span className="truncate text-[12px] text-slate-200">{l.message}</span>
                            </div>
                            {l.detail && (
                              <details className="mt-1.5"><summary className="cursor-pointer text-[10.5px] text-slate-500 hover:text-slate-300">查看详情</summary>
                                <pre className="code-font mt-1.5 overflow-auto rounded-lg bg-black/60 p-2.5 text-[11px] leading-relaxed text-slate-400" style={{ maxHeight: 220 }}>{l.detail}</pre>
                              </details>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </main>

      {/* ===== 修复方案 ===== */}
      <section ref={fixRef} className="mx-auto max-w-[1440px] scroll-mt-20 px-4 pb-10 sm:px-6">
        <div className="glass rounded-2xl border border-white/10 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white"><LifeBuoy size={15} className="text-emerald-400" /> 修复方案 & 其他接入方式</h2>
            <span className="text-[11px] text-slate-500">浏览器直连受 CORS 限制;原生客户端不受影响</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {([
              { id: "py", label: "服务端加 CORS(Python)", icon: Code2 },
              { id: "node", label: "服务端加 CORS(Node)", icon: Code2 },
              { id: "claude", label: "Claude Code", icon: MonitorSmartphone },
              { id: "inspector", label: "MCP Inspector", icon: MonitorSmartphone },
              { id: "cursor", label: "Cursor", icon: MonitorSmartphone },
              { id: "desktop", label: "Claude Desktop", icon: MonitorSmartphone },
              { id: "curl", label: "cURL 验证", icon: TerminalSquare },
            ] as const).map((t) => (
              <button key={t.id} onClick={() => setFixTab(t.id)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition ${fixTab === t.id ? "bg-white/12 text-white" : "bg-white/[0.03] text-slate-400 hover:bg-white/8 hover:text-slate-200"}`}>
                <t.icon size={13} /> {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_320px]">
            <div>
              {fixTab === "py" && <CodeBlock code={pythonCorsSnippet()} />}
              {fixTab === "node" && <CodeBlock code={nodeCorsSnippet()} />}
              {fixTab === "claude" && <CodeBlock code={claudeCodeCmd(mcpUrl)} maxHeight={160} />}
              {fixTab === "inspector" && <CodeBlock code={inspectorCmd(mcpUrl)} maxHeight={160} />}
              {fixTab === "cursor" && <CodeBlock code={cursorConfig(mcpUrl)} maxHeight={200} />}
              {fixTab === "desktop" && <CodeBlock code={claudeDesktopConfig(mcpUrl)} maxHeight={220} />}
              {fixTab === "curl" && <CodeBlock code={curlSnippet(mcpUrl, token || null)} maxHeight={200} />}
            </div>
            <div className="space-y-2 text-[12px] leading-relaxed text-slate-400">
              {(fixTab === "py" || fixTab === "node") && (
                <>
                  <p className="font-semibold text-slate-200">为什么需要这个?</p>
                  <p>网页运行在别的域名下,浏览器只有在服务端明确返回 <span className="code-font text-slate-300">Access-Control-Allow-Origin</span> 时才允许读取响应。原生客户端(命令行/桌面 App)没有这个限制。</p>
                  <p className="font-semibold text-slate-200">三个易错点</p>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>CORS 中间件要在鉴权中间件<b>外层</b>,否则 401 响应没有 CORS 头</li>
                    <li>必须响应 <span className="code-font">OPTIONS</span> 预检(POST + Authorization 头会触发)</li>
                    <li>必须 <span className="code-font">expose_headers</span> 暴露 <span className="code-font">Mcp-Session-Id</span>,否则第二个请求会因缺少会话 ID 报 400</li>
                  </ul>
                  <p>改完重启服务后,回到上面点「重新诊断」即可。</p>
                </>
              )}
              {(fixTab === "claude" || fixTab === "inspector" || fixTab === "cursor" || fixTab === "desktop") && (
                <>
                  <p className="font-semibold text-slate-200">推荐:不改服务端的最快路径</p>
                  <p>这些客户端自己实现了 MCP OAuth 流程:添加后首次使用会自动打开浏览器到 <span className="code-font">/oauth/authorize</span>,你输入 password 即可,不受 CORS 影响。</p>
                  <div className="flex items-center justify-between rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2">
                    <span className="text-[11px] text-amber-200">授权页要输入的 password</span>
                    <CopyBtn text={password} />
                  </div>
                  <p className="text-slate-500">提示:隧道地址变化后记得同步更新配置。</p>
                </>
              )}
              {fixTab === "curl" && (
                <>
                  <p className="font-semibold text-slate-200">在终端验证服务端本身是否正常</p>
                  <p>cURL 不受 CORS 限制。没带 token 时应返回 <span className="code-font">401</span> + <span className="code-font">WWW-Authenticate</span>;带上有效 token 应返回 initialize 结果和 <span className="code-font">Mcp-Session-Id</span> 头。</p>
                  <p>如果 cURL 也失败,说明是隧道/服务端问题,与浏览器无关。</p>
                </>
              )}
            </div>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-slate-700">Tunnel MCP 控制台 · Streamable-HTTP + SSE · OAuth 2.1 PKCE · MCP 2025-06-18 / 2025-03-26 / 2024-11-05</p>
      </section>
    </div>
  );
}

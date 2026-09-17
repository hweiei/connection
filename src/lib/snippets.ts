/* 服务端修复 & 原生客户端接入的代码片段 */

export function workerDeploySnippet(workerName = "connection"): string {
  return `# ========= 方式 A:在 Cloudflare 后台自动构建(Git 绑定)=========
# 进入 Workers & Pages → ${workerName} → Settings → Build,两个框分开填:
#
#   Build command (构建命令):
#     npm run build
#
#   Deploy command (部署命令):
#     npx wrangler deploy
#
# ⚠️ 不要把两句粘在一起写成 "npm run buildnpx wrangler deploy"!
# 如果你的界面只有一个命令框,中间必须用 && 连接:
#     npm run build && npx wrangler deploy
#
# 确认仓库根目录已提交这两个文件(本项目已生成):
#   - wrangler.toml    (name = "${workerName}",main = "worker/index.js",[assets] directory = "./dist")
#   - worker/index.js  (带 /__proxy 与 /__proxy/health 路由)

# ========= 方式 B:在本机终端手动部署 =========
npm install
npm run build
npx wrangler deploy

# ========= 部署后验证(应返回 JSON,而不是 HTML)=========
curl https://${workerName}.32024755.workers.dev/__proxy/health
# 期望输出: {"ok":true,"service":"tunnel-mcp-worker-proxy","version":"1.0.0",...}`;
}

export function workerAiBridgeSnippet(workerBase: string, mcpUrl: string, password: string): string {
  const b = (workerBase || "https://connection.32024755.workers.dev").replace(/\/$/, "");
  const encMcp = encodeURIComponent(mcpUrl);
  const encPwd = encodeURIComponent(password);
  return `# ========= AI / 浏览器 GET → OAuth 登录 + MCP POST 全自动桥接 =========
# 1) 连接并列出所有 MCP 工具 (单个 GET 请求自动完成 OAuth 登录 + initialize + tools/list):
${b}/__mcp?op=connect

# 2) 指定隧道与密码连接:
${b}/__mcp?op=connect&tunnel=${encMcp}&password=${encPwd}

# 3) 用 GET 请求直接调用本机 MCP 工具 (Worker 自动转成 POST tools/call):
${b}/__mcp?op=call&tool=<工具名>&args=${encodeURIComponent('{"path":"."}')}

# 4) 仅自动获取 OAuth access_token:
${b}/__mcp?op=token`;
}

export function workerProxyTestSnippet(workerBase: string, mcpUrl: string): string {
  const target = encodeURIComponent(mcpUrl);
  return `# 通过 Worker 代理直接握手 MCP(服务端转发,不受 CORS 影响)
curl -i '${workerBase}/__proxy?url=${target}' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 响应头里会带:
#   X-Proxy-Target : 实际请求到的目标
#   X-Proxy-Status : 上游返回的状态码
#   X-Proxy-Ms     : Worker → 隧道 的耗时`;
}

export function pythonCorsSnippet(): string {
  return `# coding-tools-mcp 若基于 Starlette / FastAPI / FastMCP(uvicorn 8000 端口)
# 在创建 app 之后加上 CORS 中间件 —— 注意必须放在认证中间件的"外层"
from starlette.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # 生产环境请改成你的前端域名
    allow_methods=["*"],          # 必须包含 OPTIONS(预检)与 POST
    allow_headers=["*"],          # 放行 Authorization / Mcp-Session-Id / Mcp-Protocol-Version
    expose_headers=["Mcp-Session-Id", "WWW-Authenticate"],  # 浏览器才能读到会话 ID
)

# 如果用的是 FastMCP:
# mcp.run(transport="streamable-http", middleware=[Middleware(CORSMiddleware, ...)])
# 或 app = mcp.streamable_http_app(); app.add_middleware(CORSMiddleware, ...)`;
}

export function nodeCorsSnippet(): string {
  return `// 若 coding-tools-mcp 是 Node / Express 实现
import cors from "cors";

app.use(cors({
  origin: "*",                          // 生产环境改成你的前端域名
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept",
                   "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
  exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
}));
// 关键:app.use(cors()) 必须写在 OAuth 鉴权中间件之前,
// 否则 401 响应不会带 CORS 头,浏览器只能看到 "Failed to fetch"。`;
}

export function claudeCodeCmd(url: string): string {
  return `claude mcp add --transport http coding-tools ${url}
# 首次调用时 Claude Code 会自动弹出浏览器走 OAuth,在页面里输入 password 即可`;
}

export function inspectorCmd(url: string): string {
  return `npx @modelcontextprotocol/inspector
# 打开后:Transport 选 "Streamable HTTP",URL 填 ${url}
# 点击 Connect → 会自动跳转授权页 → 输入 password → 完成`;
}

export function cursorConfig(url: string): string {
  return JSON.stringify(
    { mcpServers: { "coding-tools": { url } } },
    null, 2,
  ) + "\n// 保存到 ~/.cursor/mcp.json;Cursor 会自动处理 OAuth 登录";
}

export function claudeDesktopConfig(url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "coding-tools": {
          command: "npx",
          args: ["-y", "mcp-remote", url],
        },
      },
    },
    null, 2,
  ) + "\n// 保存到 claude_desktop_config.json;mcp-remote 会代理 OAuth 流程";
}

export function tokenConfig(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "coding-tools": {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null, 2,
  );
}

export function curlSnippet(url: string, token?: string | null): string {
  const auth = token ? `  -H "Authorization: Bearer ${token}" \\\n` : "";
  return `curl -sS -N '${url}' \\
${auth}  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' -i`;
}

/* 服务端修复 & 原生客户端接入的代码片段 */

export function gatewayConfigSnippet(gatewayUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "coding-tools": {
          type: "http",
          url: gatewayUrl,
        },
      },
    },
    null, 2,
  ) + "\n// 不需要任何 Authorization / token —— Worker 网关内部自动完成 OAuth 登录";
}

export function gatewayCurlSnippet(gatewayUrl: string): string {
  return `# AI / 命令行直接把 /gateway 当成"免认证"的 MCP 端点
# Worker 内部会用内置 password 自动登录并加上 token

# 1) 探活(GET 会被网关自动转成 initialize)
curl -i '${gatewayUrl}'

# 2) 标准 MCP 调用(POST)
curl -sS '${gatewayUrl}' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 查看网关/token 状态
curl '${gatewayUrl}/health'
# 强制重新登录
curl -X POST '${gatewayUrl}/login'`;
}

export function workerDeploySnippet(workerName = "connection"): string {
  return `# 1) 在项目根目录确认这两个文件已存在(本项目已自带):
#      worker/index.js   ← 带 /__proxy 代理路由的 Worker
#      wrangler.toml     ← name = "${workerName}",[assets] directory = "./dist"

# 2) 构建前端 + 部署 Worker(一条龙)
npm install
npm run build
npx wrangler deploy

# 3) 验证代理是否生效(应返回 JSON,而不是 HTML)
curl https://${workerName}.32024755.workers.dev/__proxy/health

# 期望输出:
# {"ok":true,"service":"tunnel-mcp-worker-proxy","version":"1.0.0",...}

# 4) 回到页面点「探测代理状态」,变成「已启用」即大功告成`;
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

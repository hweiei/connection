# 🚀 部署 Tunnel MCP 控制台到公网

## 方法 1: Cloudflare Pages (推荐, 免费)

### 步骤
1. **Fork 这个项目**到你的 GitHub
2. **创建 Cloudflare Pages 项目**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages → 创建项目
   - 连接 GitHub 仓库,选择分支 `main`
   - 构建命令: `npm run build`
   - 输出目录: `dist`
   - 点击 **保存并部署**
3. **等待部署完成** (约 1-2 分钟)
   - 部署完成后会得到一个公网地址: `https://<项目名>.pages.dev`
4. **打开这个地址**
   - 页面会自动检测你的 CF 隧道,并引导完成 OAuth 授权

### 环境变量 (可选)
如果你想预填不同的默认值:
- `VITE_DEFAULT_MCP_URL` - 默认 MCP 端点
- `VITE_DEFAULT_PASSWORD` - 默认 OAuth password

在 Pages 项目设置 → 环境变量中添加即可。

---

## 方法 2: Vercel (同样免费)

### 步骤
1. Fork 这个项目
2. 打开 [Vercel](https://vercel.com/) → Import Project → 选择 GitHub 仓库
3. 确认设置:
   - Framework Preset: Vite
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. 点击 Deploy
5. 部署完成后访问生成的 Vercel 域名

---

## 方法 3: Netlify

### 步骤
1. Fork 这个项目
2. 打开 [Netlify](https://app.netlify.com/) → Add new site → Import from GitHub
3. 选择仓库,配置:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. 点击 Deploy

---

## 方法 4: 直接放到你的 CF Worker (高级)

如果你已经有 Cloudflare Worker:

```javascript
// worker.js
export default {
  async fetch(request) {
    // 返回 index.html 对所有路径 (SPA)
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return await fetch('https://your-pages-dev.pages.dev');
    }
    // 或直接代理到 dist 文件
    return await fetch('https://your-domain.com' + url.pathname);
  }
}
```

---

## 部署后的使用

1. 打开你的公网地址 (比如 `https://mcp-console.pages.dev`)
2. 页面会自动:
   - 检测你的 CF 隧道连通性
   - 如果需要授权,点击「开始 OAuth 授权」
   - 在弹出的授权页输入 password
   - 自动换取 token 并连接 MCP

3. 连接成功后就可以:
   - 浏览所有工具、资源、提示词
   - 执行工具并查看结果
   - 复制配置到 Claude Code / Cursor 等客户端

---

## 注意事项

1. **隧道临时性**: trycloudflare 链接是临时的。如果你重启了本地的 `cloudflared` 和 `coding-tools-mcp` 进程,隧道地址会变。你需要:
   - 更新页面上的 MCP 端点地址
   - 或者重新部署 Pages 项目(但通常只需刷新页面)

2. **OAuth 会话**: 授权后的 token 存储在浏览器 localStorage 中,跨设备需要重新授权。

3. **CORS**: 如果你的 MCP 服务端没有开启 CORS,浏览器直连会被拦截。解决方案:
   - 给 coding-tools-mcp 加 CORS 中间件 (见页面下方的修复方案)
   - 或者使用原生客户端 (Claude Code / Cursor / MCP Inspector)

4. **安全**: 部署到公网后,任何知道这个地址的人都可以访问。请注意:
   - 不要公开分享包含 password 的页面
   - password 只在 OAuth 授权页使用,不会出现在请求日志中
   - token 有效期由你的服务端决定

---

## 问题排查

### Q: 部署后打开页面是空白
A: 确认构建成功,检查 Pages 项目的 "Deployments" 标签页是否有错误。通常是 `npm run build` 失败。

### Q: 连接时提示 "Failed to fetch"
A: 这是 CORS 问题。服务端需要开启 CORS。见页面下方的 Python/Node 修复代码。

### Q: OAuth 授权页打不开
A: 确认你的 MCP 服务端的 `/oauth/authorize` 端点正常工作。可以用 cURL 测试:
```bash
curl -i "https://affiliates-geek-roger-rides.trycloudflare.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http://localhost&code_challenge=abc&code_challenge_method=S256&state=x"
```

### Q: 授权成功但 token 交换失败
A: 检查 `/oauth/token` 端点。确保:
- client_id 正确
- code_verifier 正确
- redirect_uri 一致
- 服务端支持 `token_endpoint_auth_method: none`

---

## 手动构建并部署

如果你不想用自动部署:

```bash
# 本地构建
npm run build

# 部署到任意静态服务器
# 将 dist/ 目录下的所有文件上传到你的服务器
# 确保服务器返回 index.html 对所有路径 (SPA 支持)
```

---

## 更新部署

当你修改代码后:
1. 提交到 GitHub
2. Cloudflare Pages / Vercel / Netlify 会自动重新部署
3. 刷新页面即可

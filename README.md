# Alignyard

Alignyard 是一套云端协作平台与用户本地 Runner。云端负责用户、Repository、Task、Review、Prompt 和工程知识；Git checkout、worktree、tmux、Agent CLI 与 `gh`/`glab` 始终在用户自己的 Mac 上运行。

## 架构

```text
Browser ──HTTPS/WSS──> Platform + SQLite
                           ▲
                           │ 出站 WebSocket
                           │
                     macOS Runner
                     ├─ Git/worktree/tmux
                     ├─ Codex/Claude/Kimi
                     └─ gh/glab/本机凭据
```

仓库只有一个产品：Alignyard。`server/platform/` 是云端组合根，`server/runner/` 是本地进程，`server/repo/`、`server/task/`、`server/session/` 和 `server/protocol/` 是两者按边界复用的执行内核，不再保留独立的 Switchyard Web/API 产品入口。

当前约束：

- Platform 使用单实例 SQLite；
- Runner 首版只支持 macOS；
- 一个 Task 当前只支持一个 editable Repository；
- Runner 安装包自带 Node runtime，但不打包 Codex、Claude、Kimi、git、tmux、gh 或 glab；
- 公网只部署 Platform，用户机器不开放入站端口。

## 本地开发

```bash
npm ci
npm run dev
```

默认入口是 `server/platform/main.ts`。本地 Runner 可前台启动：

```bash
npm run runner -- doctor
npm run runner -- pair --platform http://127.0.0.1:4500 --code XXXX-XXXX-XXXX
npm run runner -- start
```

工程知识 CLI：

```bash
npm run ay -- validate .
```

## 部署

```bash
cp .env.example .env
./scripts/deploy-platform.sh
```

Compose 只把 Platform 暴露在宿主机 `127.0.0.1:4500`，由 Caddy、Nginx 或云负载均衡器终止 HTTPS。部署不绑定 GCP；VM 只需要 Docker、持久磁盘、域名与 HTTPS。

Runner 制品在对应架构的 Mac 上构建：

```bash
npm run build:runner:macos
```

详细说明见 [部署文档](docs/deployment.md)、[架构说明](docs/architecture.md) 和 [.alignyard 工程知识](.alignyard/README.md)。

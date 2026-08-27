# Alignyard

Alignyard 是面向 AI-native 团队的核心工程意图与架构约束协作平台。`.alignyard/` 保存 AI 不能随意重新决定的产品意图、系统边界、长期取舍和变更契约；代码、类型、测试与运行行为继续承载具体实现事实。Platform 只负责用户、Repository/Task/Review 状态和流程框架，不保存工程知识、摘要或 Git diff；Git checkout、worktree、tmux、Agent CLI 与 `gh`/`glab` 始终在用户自己的 Mac 上运行。普通 Task 默认先形成经过审核的最小充分设计包，编码是可接入但非必选的后续能力。

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
npm run ay -- new plan <slug> --scope <scope> --title '<中文标题>'
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

# Alignyard 架构

Alignyard 是一个产品，两种进程：云端 Platform 与用户本地 Runner。Platform 管理协作状态；Runner 使用用户电脑上的 Git、worktree、tmux、Agent 和 gh/glab。云端不 clone 用户 Repository，也不保存这些工具的凭据。

```text
Browser ── HTTPS/session ──► Platform + SQLite
                                  ▲
                                  │ authenticated outbound WSS
                                  ▼
                            macOS Runner
                       Git · worktree · tmux
                       Codex/Claude/Kimi · gh/glab
```

## 组件边界

Platform 负责 Web、Google 登录、Repository 元数据、Task、Review、Prompt、Runner registry、有限 RPC，以及 execution-scoped 终端中继。Repository 与 Task 的具体工程知识始终留在用户 worktree；Platform 只在用户打开对应 Task 时按需解析和呈现 `.alignyard/`。唯一入口为 `server/platform/main.ts`。

Runner 负责本机 Repository mirror、隔离 worktree、tmux、Agent、push 与 PR/MR。唯一入口为 `server/runner/main.ts`。用户机器只建立出站连接，不开放入站端口。

`server/repo/`、`server/task/`、`server/session/` 与 `server/protocol/` 是 Alignyard 内部执行内核，不是另一套本地产品。仓库不包含 Host fleet、Network、Provider、本地控制台或任意 shell RPC。

## 数据所有权

| 数据 | 所有者 |
|---|---|
| User、Repository 登记、Task、Review | Platform SQLite |
| Git checkout、凭据、worktree、tmux、Agent 登录 | Runner |
| `.alignyard/` | Git Repository；Platform 只保存显式同步快照 |
| PR/MR | GitHub/GitLab；Platform 保存 number/URL/state 摘要 |

Browser session、Runner device token 与 Task execution token 相互独立。Runner 把 execution token 写入权限 `0600` 的本地文件并仅传 `AY_PLATFORM_TOKEN_FILE`；设备 token 永不进入 Agent 环境。

## 目录

```text
server/
  platform/       云端 catalog、workflow、sync、Prompt 和组合根
  runner/         配对、registry、gateway、client、operations 与 CLI
  http/           HTTP/WS 鉴权和协议适配
  core/           SQLite、路径和小型基础接口
  repo/           Runner-local Git mirror/worktree
  task/           runtime Task、引用、manifest 与 lifecycle
  session/        Agent、tmux 与 PTY
  protocol/       .alignyard/ 校验、生成与 ay sync
web/              唯一浏览器应用
scripts/          通用部署与自包含 Runner 构建
```

完整状态机、安全边界与演进规则以 [`.alignyard/docs/shared/architecture.md`](../.alignyard/docs/shared/architecture.md) 为准。

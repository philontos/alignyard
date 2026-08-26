---
id: doc.shared.architecture
title: "架构与数据流"
kind: doc
scope: shared
owners: []
relations:
  - doc.server.overview
  - doc.server.http-api
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
---

# 概述

Alignyard 由云端 Platform、浏览器 Web、用户本地 Runner 和内部执行内核组成。它们位于同一仓库，但进程与数据所有权明确分离。

```text
Browser ── HTTPS / session ──► Platform + SQLite
                                  │
                                  │ authenticated RPC / PTY relay
                                  ▼
                     outbound WSS from macOS Runner
                                  │
                    Git · worktree · tmux · Agent · gh/glab
```

| 对象 | 真源 | 可跨边界内容 |
|---|---|---|
| User、Repository 登记、Task、Review | Platform SQLite | 协作状态与公开成员摘要 |
| `.alignyard/` 工程知识 | Git Repository；Platform 保存显式同步快照 | 相对路径、全文、hash、commit、评审状态 |
| Repository clone 与凭据 | Runner | 无凭据 Git URL、默认分支、branch/commit 摘要 |
| worktree、tmux、Agent 登录 | Runner | execution 状态和 session 名；不传本机路径 |
| PR/MR | GitHub/GitLab | number、URL、远端状态 |
| Runner 凭据 | Runner 本地配置 | Platform 仅保存 hash |

## 完整闭环

1. 用户登录 Platform；Web 查询当前用户的在线 Runner。
2. 没有 Runner 时，Web 创建十分钟、单次使用的 pairing code，并展示 macOS 安装命令。
3. Runner claim 后保存设备 token，建立到 `/runner` 的出站 WebSocket，完成兼容 `runner.hello` 后才被视为在线。
4. 用户登记无凭据 Repository。分支查询和协议 refresh 通过当前用户的 Runner 执行，Platform 不 clone。
5. 当前实现每个 Task 只允许一个 editable Repository。Platform 创建 execution、稳定工作分支和短期 Task-scoped token，再调用该用户的 Runner。
6. Runner 幂等准备 Repository，持久化 `execution_id → runner_task_id`，创建隔离 worktree 和 tmux，并调用用户已有 Agent CLI。
7. Browser 用 `/pty?execution=<id>` 连接终端。Platform 校验 actor，Runner 校验本地 Task/session；断开浏览器不杀死 tmux。
8. Agent 执行 `ay validate`、`ay sync` 并提交。提交 Review 时 Runner 再检查 clean worktree、HEAD 与同步 commit 一致，push 后停止 Author session。
9. Reviewer 在自己的 Runner 上获得独立 execution 和 review branch。退回后恢复原 Author Runner；批准后由 Author Runner 使用本机 `gh`/`glab` 创建和合并 PR/MR。
10. 只有确认远端 PR/MR 已合并后，Task 才能进入 `completed`，随后清理 execution token 和本地执行资源。

## 模块依赖方向

```text
platform/main → platform/app → http adapters → platform workflow/catalog
                                      │
                                      └→ runner gateway/registry

runner/main → runner client → runner operations → repo/task/session/protocol
                                              └→ platform/forge（纯 CLI 适配）
```

Platform 组合根不得 import `runner/operations`、`repo/git`、`task/createtask` 或 `session/tmux`。Runner 不依赖 Express 路由或浏览器状态。`PlatformRouteBackend` 是 HTTP 与执行工作流之间的小型端口；生产只有 Runner 实现，不存在 local mode 分支。

## 持久化与恢复

- Platform 默认使用 `~/.alignyard/runtime`，容器使用 `ALIGNYARD_DATA_DIR=/data`。SQLite WAL 模式只支持单进程/单副本部署；扩容前必须先更换共享数据库设计。
- Runner 使用 `~/.alignyard/runtime` 保存 SQLite、mirror、worktree、Task manifest 与 execution token 文件；`~/.alignyard/runner.json` 权限为 `0600`。
- `execution.start` 使用稳定 execution ID 和工作分支。响应丢失后重试会复用 binding 或按工作分支恢复，不重复创建 worktree。
- execution token 通过权限 `0600` 文件交给 Agent，不放在命令行或 Repository；stop/cleanup/失败后失效，恢复时重新签发。
- Runner 选择对已存在 execution 保持粘性。离线不会静默迁移，因为另一设备没有同一 worktree 与 Agent 会话。

## 安全与发布边界

- Browser session、Runner device token 和 Task execution token 是三套不可互换的凭据。
- pairing、session、device 和 execution token 在 Platform SQLite 只保存 hash。
- Runner RPC 是固定方法 allowlist，不提供任意 shell/argv 接口。
- Git URL 拒绝内嵌用户名和密码；Git、SSH、Agent、gh/glab 凭据只由本机命令读取。
- 通用部署使用 Docker Compose 和反向代理 HTTPS。云厂商 VM 的创建、SSH 和上传可以由本机辅助工具完成，但不得写死到仓库部署链路。
- 未签名、未 notarize 的 Runner 仅适合受信测试用户；公开发布前需要签名 manifest、Apple notarization、自动升级和回滚。
- 公网反向代理应对登录和 pairing claim 做请求速率限制；应用内目前没有适合多实例的 rate limiter。

## 演进约束

- 优先按职责拆分大文件，但不为行数制造只有一处使用的层级。当前应继续拆分的热点是 `platform/catalog.ts`、`platform/runner-workflow.ts` 与 `web/js/platform.js`。
- `core/schema.ts` 仍是 Platform/Runner 共用的迁移入口；数据目录已经隔离，但物理 schema 尚待拆分。拆分时先增加双路径迁移测试，不直接删除已有表或列。
- 删除功能时同步删除入口、路由、Web、依赖、测试和文档，不保留完整影子实现。
- 历史 schema 字段只能作为迁移债务保留；新代码不得重新依赖它们。
- `.alignyard/` 记录通用设计，不记录任何运行实例的用户、Repository、Task 或秘密数据。

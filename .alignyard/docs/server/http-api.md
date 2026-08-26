---
id: doc.server.http-api
title: "HTTP 与 WebSocket 契约"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.architecture
  - doc.server.overview
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
  - doc.web.overview
---

# 概述

`server/platform/app.ts` 组合唯一公开服务：静态 Web、身份认证、Platform API、Runner 配对/管理、Runner 制品下载和两个 WebSocket endpoint。不存在另一套本机 API。

## 页面、健康检查与下载

- `GET /` 返回 `web/platform.html`；静态资源来自 `web/`。
- `GET /healthz` 执行 SQLite `SELECT 1` 并返回 `{ ok: true }`。
- `GET /downloads/runner/...` 从 `ALIGNYARD_RUNNER_ARTIFACT_DIR` 或 `dist/runner` 提供 bootstrap、archive、SHA-256 和 manifest。
- JSON body 上限为 `10mb`，用于显式同步工程知识快照。

## 认证

- `GET /api/auth/config` 返回 auth mode、固定的 `runner` execution mode 和公开 Google client ID。
- 浏览器使用 Google credential 换取 HttpOnly Platform session；本地开发可以使用 local auth mode。
- 可选 service token 只用于受信自动化，不允许打开浏览器终端。
- execution token 只允许向自身 Task 的 `sync` endpoint 上传工程知识，且 execution 必须仍是 Task 当前活动 execution。

## Runner 管理

| 路由 | 认证 | 语义 |
|---|---|---|
| `POST /api/runner/claim` | pairing code | 单次换取 Runner ID 和设备 token |
| `GET /api/runners` | Platform session | 列出当前用户设备、能力与在线状态 |
| `POST /api/runners/pairings` | Platform session | 创建十分钟 pairing code |
| `DELETE /api/runners/:id` | Platform session | 撤销当前用户自己的设备 |

## Platform API

| 路由组 | 语义 |
|---|---|
| `GET/POST /api/platform/repositories` | 查询或登记无凭据 Repository 元数据 |
| `DELETE /api/platform/repositories/:id` | 无 Task 引用时由创建者删除 |
| `GET /api/platform/repositories/:id/branches` | 经当前用户在线 Runner 查询分支 |
| `POST /api/platform/repositories/:id/initialize` | 创建 Repository Init Task |
| `POST /api/platform/repositories/:id/refresh` | 经 Runner 读取默认分支必需工程知识 |
| `GET/POST /api/platform/tasks` | 查询或创建 Task；当前只允许一个 editable Repository |
| `GET/PATCH/DELETE /api/platform/tasks/:key` | 查询、允许的状态变更或清理 |
| `POST /api/platform/tasks/:key/run` | 启动/恢复 Author execution |
| `POST /api/platform/tasks/:key/review` | 校验、push、停止 Author 并创建 Review |
| `POST /api/platform/tasks/:key/review/run` | 在 Reviewer 自己的 Runner 启动 Review execution |
| `POST /api/platform/tasks/:key/review/decision` | approve 或 changes requested |
| `POST /api/platform/tasks/:key/pull-request` | 经 Author Runner 创建/刷新 PR/MR |
| `POST /api/platform/tasks/:key/merge` | 经 Author Runner 合并并刷新协议状态 |
| `POST /api/platform/tasks/:key/sync` | 接收并验证 `ay sync` 快照 |
| `GET /api/platform/artifacts` | 查询已同步工程知识 |

Repository、Task 和 Review 变更必须通过当前登录用户的 owner/reviewer 校验。路由层只映射输入和状态码，状态机由 `platform/runner-workflow.ts` 与 catalog 承担。

## `/runner` WebSocket

Runner 使用 `Authorization: Bearer <device-token>` 建立出站连接。同一设备的新连接替换旧连接。只有收到版本兼容的 `runner.hello` 后，gateway 才允许 RPC 与 terminal 数据面。连接断开会立即令待处理 RPC 失败并关闭关联终端。

## `/pty` WebSocket

正式终端只接受 `/pty?execution=<execution_id>`：

1. Platform session 必须有效，且当前用户等于 execution actor。
2. Platform 根据 execution 取得 Runner 与本地 Task 摘要，不接受 browser 传 session、Host 或路径。
3. Runner 再验证 `runner_task_id` 与 session 绑定后 attach tmux。
4. 断开只终止 PTY attach，不杀死 tmux。

## 状态码

- `400`：输入、文档或状态值无效。
- `401`：登录、device token 或 session 无效。
- `403`：主体无权操作该 Repository、Task、Review、Runner 或 execution。
- `404`：资源不存在。
- `409`：Runner 离线/不兼容、能力不足、阶段冲突或资源仍被引用。
- `502`：Runner、Git 或 forge 操作失败。
- `503`：认证或数据库配置不可用。

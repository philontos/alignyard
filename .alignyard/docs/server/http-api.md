---
id: doc.server.http-api
title: "HTTP 与 WebSocket 契约"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.architecture
  - doc.server.overview
  - doc.server.cli-configuration
  - doc.server.knowledge-protocol
  - doc.web.overview
---

# 概述

`server/http/app.ts` 在一个 Express app 中提供静态文件与 JSON API，`server/http/routes.ts` 注册领域路由，`server/http/ws.ts` 只接受 `/pty` upgrade。该接口主要服务仓库内浏览器应用和已登记节点，不是面向不可信公网的公共 API；当前没有应用层多用户认证。

## 页面与通用约定

- `GET /` 返回 `web/platform.html`，即当前 Alignyard 入口。
- `web/` 以静态文件方式提供，但关闭默认目录 index；保留的 Switchyard 页面可显式访问 `/index.html`。
- `/vendor/highlight` 只暴露安装依赖 `@highlightjs/cdn-assets` 的固定目录，代码预览不依赖公共 CDN。
- 默认 JSON body 上限为 `10mb`。图片粘贴路由另用 raw body，限制 `25mb`。
- 旧 Switchyard 路由根据 `X-Lang` 返回本地化错误；平台路由使用中文语义错误。调用方必须处理非 2xx 状态与 JSON `error`。

## Alignyard 平台接口

| 路由 | 语义 |
|---|---|
| `GET/POST /api/platform/repositories` | 列出或登记不含凭据的平台 Repository |
| `DELETE /api/platform/repositories/:id` | 仅在没有 Platform Task 引用时删除；同时清理匹配的本地 Repository |
| `POST /api/platform/repositories/:id/initialize` | 创建初始化 Task 并启动或复用本地 runtime |
| `POST /api/platform/repositories/:id/refresh` | 从默认分支读取必需 `.alignyard/` 文件并更新协议状态 |
| `GET/POST /api/platform/tasks` | 列出或创建 Platform Task |
| `GET/PATCH/DELETE /api/platform/tasks/:key` | 读取、更新普通 Task 状态或安全删除 Task 及其资源 |
| `POST /api/platform/tasks/:key/run` | 启动初始化 runtime；已有 worktree 但 session 不在线时执行 Resume |
| `POST /api/platform/tasks/:key/review` | 校验 clean worktree 和已同步 HEAD，停止 runtime 并进入 Review |
| `POST /api/platform/tasks/:key/pull-request` | 人工批准后 push 分支并通过 `gh`/`glab` 创建或复用 PR/MR |
| `POST /api/platform/tasks/:key/merge` | 合并 PR/MR，刷新默认分支协议状态并尝试清理 runtime |
| `POST /api/platform/tasks/:key/sync` | 接收 `ay sync` 的 manifest 与完整文档快照 |
| `GET /api/platform/artifacts` | 列出已同步的工程知识 artifact |

初始化 Task 不允许用通用 PATCH 跳过 Review、PR/MR 和 Merge 操作。平台 workflow 对同一 Task 的并发启动、创建合并请求和合并操作做进程内折叠；外部 Git forge 操作失败后会先查询远端实际状态，再决定是否报错。

## 节点运行时接口

路由按资源分为以下稳定组：

- `/api/repos`、`/api/repos/:id/fetch|branches`：本节点 Repository catalog；token 和 mirror 路径不会返回浏览器。
- `/api/tasks`、`/api/tasks/local`、`/api/tasks/:id/*`：创建、引用、改名、archive、resume、cleanup、删除、transcript 和图片粘贴。
- `/api/nodes/:hostId/repos|tasks|providers/*`：通过目标节点 `tdsp` 执行同构远端操作；目标节点 capabilities 不足时返回明确冲突或升级提示。
- `/api/fleet`、`/api/hosts`、`/api/sessions`：聚合节点视图、登记/bootstrap/update 主机和管理 tmux attach 会话。
- `/api/network/*`、`/.well-known/switchyard`：Tailscale 状态、发现、同账号验证、双向握手与 SSH 配对。
- `/api/onboarding/*`：实时派生网络、手机、供电和 keep-awake 状态，不保存笼统的“已完成”标志。
- `/api/providers/*`：检查与保存本节点 Provider；浏览器只能得到脱敏摘要。
- `/api/code/inspect`：在 owner-local Repository/worktree 边界内执行只读树、diff 和文件查看。
- `/api/system/update`：更新已安装 checkout，安排相同参数重启，然后结束当前进程。

具体请求/响应 shape 由相应领域类型和同目录测试定义，例如 `server/task/cli.ts`、`server/codeview/codeview.ts`、`server/session/transcript.ts` 与 `server/network/peering.ts`。新增字段应优先保持加法兼容；不得把原始路径或凭据加入跨节点 DTO。

## WebSocket 终端协议

客户端只连接 `/pty`，并提供：

- 必需 `session`：必须匹配 `SESSION_RE`，且只能附着本机已拥有 session，或配合已登记远端 host。
- 可选 `host`：仅在本机找不到该 session 时解析为已登记远端 Host ID，不能指定任意 SSH 目标。
- 可选 `lang`：控制 attach 错误消息语言。

服务端用 node-pty 启动本地 tmux attach，或经 SSH/mosh 附着远端 tmux。普通 WebSocket 文本直接写入 PTY；以 NUL 开头的控制帧包括 `\0resize:<cols>x<rows>` 和 `\0submit:<json>`。断开 WebSocket 只结束 attach client，不杀死 tmux session。连接建立后服务端会规范 tmux 选项并退出遗留 copy mode。

## 状态码与边界

- `400` 表示字段、格式、文档或状态值无效。
- `404` 表示 Platform/Repository/Task 不存在或不属于当前可寻址边界。
- `409` 表示资源状态阻止操作，例如 Repository 未就绪、Task 阶段不符、未 sync、存在活动 Task 或只读 Repository。
- `502` 多用于 SSH、Git forge 或外部节点操作失败。
- 未分类内部错误返回 `500`。

路由层的状态码是协作契约；领域模块仍应返回语义结果，避免把 Express 依赖扩散到 `platform/`、`task/`、`repo/` 等目录。

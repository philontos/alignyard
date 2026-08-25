---
id: doc.switchyard.http-realtime-api
title: "HTTP 与实时终端接口"
kind: doc
scope: switchyard
owners: []
relations:
  - doc.switchyard.overview
  - doc.switchyard.node-task-protocol
  - doc.alignyard.task-workflow
---

# 概述

共享服务使用 Express 提供静态资源和 JSON API，并在 Node HTTP server 上挂载 `/pty` WebSocket。该接口面目前由仓库内两个浏览器客户端和节点间控制使用，不是带版本号的公网 API；维护时仍须保持请求语义、owner 边界和错误形状稳定。

`server/http/app.ts` 设置 10 MiB JSON 限制，把 `/` 映射到 `web/platform.html`，以 `index: false` 提供 `web/` 静态文件，并把本地安装的 highlight.js 暴露在受限的 `/vendor/highlight` 路径。图像粘贴端点单独接受最多 25 MiB 的 `image/*` 原始 body。

## REST 路由分组

| 路由前缀 | 主要用途 |
|---|---|
| `/api/system` | 当前安装的受控更新 |
| `/api/onboarding` | 实时网络、手机二维码/check-in 与 macOS 保活状态 |
| `/.well-known/switchyard`、`/api/network` | 节点描述、同 tailnet 握手、发现与连接 |
| `/api/repos` | 本节点 Repository 登记、fetch、branch 查询和删除 |
| `/api/tasks` | 本节点任务列表、创建、引用、粘贴、transcript、archive、cleanup、resume、rename 和删除 |
| `/api/code/inspect` | 类型化、只读的 Repository/worktree 代码查看 |
| `/api/fleet`、`/api/nodes/:hostId` | 聚合节点视图，并把 Repository、任务、Provider 和 transcript 操作下沉到指定节点 |
| `/api/sessions` | 本节点 tmux 会话列表和精确 session 终止 |
| `/api/hosts` | 手工节点登记、bootstrap、更新和删除 |
| `/api/providers` | 本节点 Provider 安全摘要、连通测试、创建和删除 |
| `/api/platform` | Alignyard Repository、Task、artifact、Review 与同步；详见 `doc.alignyard.task-workflow` |

本地 `/api/repos` 与 `/api/tasks` 只解析 owner-local 行。`/api/nodes/:hostId/...` 先验证已登记 host 和在线状态，再调用该节点的 `tdsp` 结构化命令；不得允许请求提供任意 SSH target、文件路径或本地数据库 id 来绕过 catalog。

## 任务读取与写入边界

任务列表把 sqlite 行与实时 tmux/worktree/等待状态组合后输出。远端 payload 会再次投影为公开 DTO，旧节点曾返回的 `git_url`、`mirror_path` 或完整 task 行也必须在控制器边界被剔除。transcript 和代码查看都采用类型化请求，并将失败归一化，不能返回原始 owner-local 文件系统错误。

所有任务变更最终调用 `server/task/` 的共享领域函数并同步 manifest。HTTP 路由不应自行实现第二套任务生命周期。Provider API 同样只向选择器暴露 name/id 等摘要，不返回凭据或 endpoint。

## 实时终端协议

唯一接受 upgrade 的路径是 `/pty`。连接参数包括：

- `session`：必填，必须匹配 dispatcher session 正则。
- `host`：仅当本地找不到该 session 时作为已登记远端 host id 提示；不能是任意地址。
- `lang`：选择连接错误信息语言。

服务端根据任务归属构造本地 tmux 或 SSH/mosh attach 命令，由 `node-pty` 启动客户端进程。连接立即注册双向监听，再异步设置 tmux 选项和退出 copy mode，避免浏览器初始 resize 在 await 期间丢失。

浏览器到服务端的数据帧约定为：

- 普通文本：直接写入 PTY。
- `\0resize:<cols>x<rows>`：调整 PTY 尺寸。
- `\0submit:<json>`：解析 `text`，通过 tmux paste-buffer 提交，避免多行或 IME 输入被终端逐字误处理。

PTY 输出作为文本帧回传。WebSocket 关闭只杀死 attach client，不杀 tmux session；tmux/SSH 支持多个客户端并发连接。

## 网络与认证限制

应用没有应用层多用户认证。`/.well-known/switchyard` 的可信身份只允许来自 loopback 或同一 Tailscale 登录用户；连接流程校验 descriptor 与 peer identity，拒绝身份替换。对外暴露服务必须依赖私有 tailnet、可信私网或外置认证反向代理。

HTTP 错误应返回合适状态码和 `{ error }` 语义；跨节点错误要区分离线、能力/版本不足与领域失败。任何新路由都必须先确定它属于本节点、指定 owner 节点还是 Alignyard 平台元数据，不能在路由层混合三者。

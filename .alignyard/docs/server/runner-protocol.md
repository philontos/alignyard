---
id: doc.server.runner-protocol
title: "Runner 安装与协议"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.architecture
  - doc.shared.development
  - doc.server.overview
  - doc.server.http-api
  - doc.server.cli-configuration
  - spec.server.framework-update
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
---

# 概述

Runner 是安装在用户 macOS 上的受控执行进程。它通过出站 WebSocket 接收有限 RPC，调用用户已有的 Git、tmux、Agent 和 forge CLI。Runner 不是 Agent，也不安装或登录 Codex、Claude、Kimi、gh、glab。

## 安装与布局

Web 创建一次性 pairing code，并展示从当前 Platform origin 下载 bootstrap 的命令。`web/downloads/install-runner-macos.sh` 根据 `uname -m` 选择 `darwin-arm64` 或 `darwin-x64`，校验 SHA-256，再调用包内安装器。

| 路径 | 用途 |
|---|---|
| `~/.alignyard/app/<version>` | 不可变版本目录、Node runtime 与 npm 依赖 |
| `~/.local/bin/alignyard-runner` | 当前版本 Runner launcher |
| `~/.local/bin/ay` | 当前版本工程知识 CLI |
| `~/.alignyard/runner.json` | Platform URL、Runner ID、设备 token、名称；权限 `0600` |
| `~/.alignyard/runtime` | SQLite、mirror、worktree 与 manifest |
| `~/.alignyard/logs` | LaunchAgent 日志 |
| `~/Library/LaunchAgents/com.alignyard.runner.plist` | 登录后常驻和自动重启 |

安装包始终使用包内 Node，避免系统 Node 版本与 `node-pty` ABI 漂移。首版只支持 macOS；`alignyard-runner upgrade` 会检查 Platform 当前架构的 stable manifest、校验 SHA-256、安装新版本并重启 LaunchAgent，但当前没有签名、notarization、后台静默升级或自动回滚。

## 配对、握手与在线状态

1. pairing code 使用安全随机数，Platform 只保存 hash，十分钟过期且只能 claim 一次。
2. claim 成功后明文设备 token 只返回一次并写入本机配置；Platform 只保存 hash。
3. Runner 用设备 token 连接 `/runner`，每 20 秒发送 `runner.hello` 与 capabilities。
4. protocol version 完全兼容后连接才是 `online`；hello 前的 RPC/terminal 数据被忽略，不兼容时为 `upgrade_required`。
5. 断线按 1 至 30 秒指数退避重连；stop 会主动关闭当前 socket。
6. 用户撤销 Runner 后设备 token 立即失效，gateway 关闭已有连接。

## Protocol v1

`server/runner/protocol.ts` 是消息类型和方法 allowlist 的唯一来源：

- `capabilities.refresh`
- `repository.branches`
- `repository.refresh-protocol`
- `execution.start|status|resume|stop|cleanup|message|prepare-review`
- `change-request.create|refresh|merge|close`

消息分为 `runner.hello`、`rpc.request`、`rpc.result`、`execution.event` 和 `terminal.*`。RPC 使用随机 request ID，默认 120 秒超时；Runner 不提供任意 shell 或 argv RPC。

## Execution 身份与幂等

- `execution_id` 是 Platform 全局随机 ID，也是授权与终端地址。
- `runner_task_id` 是 Runner SQLite 的本地整数 ID，只在认证设备通道内使用。
- Runner 持久化 `execution_id → runner_task_id` binding，并使用 Platform 给出的稳定工作分支。
- `execution.start` 响应丢失或 Platform 重试时，Runner 先查 binding，再按 Repository + 工作分支恢复；不会创建重复 worktree。
- Platform 对现有 Author execution 保持原 Runner 选择。Reviewer 使用独立 execution，不覆盖 Author binding。

当前一个 Task 只支持一个 editable Repository。这个限制换取清晰的分支、Review 与 PR/MR 语义；多 Repository 写入必须先设计跨仓库提交与失败补偿，不能只放宽数组校验。

`repository.refresh-protocol` 只从默认分支读取 manifest 和当前协议要求的有界基线文件，返回协议版本、知识框架版本及 `uninitialized`、`invalid`、`outdated`、`ready` 状态。最新版框架来自当前 Runner 制品；旧 Runner 不会凭空获得新协议，因此 Platform 同时提示 Runner 制品更新。

## 凭据边界

- 设备 token 只用于 `/runner`，从不注入 Agent。
- Agent 不获得 Platform session、service token 或 Runner device token。
- Git、SSH、gh/glab 与 Agent 登录都由本机工具自己读取，Platform 不代理或复制凭据。

## Review 与终端

- Author 的 `execution.prepare-review` 必须通过 `ay validate`、worktree clean、有新 commit，并成功 push 后才停止 session。Reviewer 批准时允许 HEAD 保持不变；若有新提交则 push 回 Author 工作分支。
- `execution.knowledge` 只索引该 execution 的本地 worktree；列表不含正文，指定 document ID 才返回正文，Platform 不持久化响应。
- Reviewer execution 使用 Reviewer 自己的在线 Runner 和独立 branch。approve 时若 Reviewer 修改过内容，同样执行 prepare-review 并 push 回 Author 工作分支。
- changes requested 会关闭 Reviewer execution、恢复 Author execution，并通过 Prompt 提醒 Author fetch/reconcile Reviewer 已 push 的修改。
- approve 会把每个 editable Repository 已推送的 Review HEAD 固化为 `design_commit`。普通 Task 到此停在可开始实现；Repository Init 继续使用 `change-request.*`。
- `/pty` 只按 execution 寻址。Platform 校验 actor，Runner 校验本地 Task/session；浏览器不知道设备 token、本地路径或本地 Task ID。

## 发布与演进

- 破坏性协议变化提升 `RUNNER_PROTOCOL_VERSION`；旧客户端必须明确显示 `upgrade_required`。
- Runner 使用独立 `server/runner/VERSION` 发布，不跟随 Platform npm package version；构建会缓存 Node archive，并按 Runner 源码指纹复用完全相同的制品。源码变化未提升 Runner version 时构建必须失败，避免同版本产生不同内容。
- 新能力先增加具体 RPC，不增加通用命令执行后门。
- 发布前必须增加签名 manifest、Apple Developer ID/notarization、原子升级、健康回滚和至少一个版本的兼容窗口。
- SHA-256 只能检测下载损坏，不能证明发布者身份。

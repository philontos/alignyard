---
id: doc.server.overview
title: "后端服务概览"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.architecture
  - doc.server.cli-configuration
  - doc.server.http-api
  - doc.server.knowledge-protocol
  - adr.shared.node-local-ownership
---

# 概述

`server/` 是一个进程内后端，不是多个可独立部署的服务。它同时承担 Alignyard 协作目录、Switchyard 节点运行时、HTTP/WebSocket、SQLite 持久化、Git/tmux/Agent 编排和 CLI。`server/index.ts` 是 HTTP 服务组合根；`server/tdsp.ts` 与 `server/ay.ts` 是两个 CLI 入口。

## 启动过程

`server/index.ts` 在启动时完成以下步骤：

1. 把常见 Homebrew 与 `/usr/local/bin` 路径补入子进程 PATH，并注册未捕获异常日志，避免单个 PTY 连接直接结束服务。
2. 打开 `dispatcher.db`、执行幂等 schema 对齐；必要时迁移旧 `./data` 并修复 worktree 链接。
3. 同步 `repos.json`，从磁盘 Task manifest 收养数据库缺失记录，并为本节点 Task 回填 manifest。
4. 创建 Express app、HTTP server 和 `/pty` WebSocket bridge；所有请求的 host 都成功监听后，才启动远端节点 liveness loop 与 keep-awake 恢复。

默认监听 `127.0.0.1:4500`。一个进程可按 `HOSTS` 绑定多个选定地址；任一 bind 失败会关闭已建立的 listener 并让 `tdsp serve` 失败，不会留下宣称 ready 的生命周期记录。

## 领域目录

| 目录 | 职责 |
|---|---|
| `core/` | 数据路径、SQLite/schema/migration、归属过滤、i18n、serve 生命周期 |
| `platform/` | Platform Repository/Task/artifact catalog、初始化工作流、知识同步、GitHub/GitLab PR/MR 适配 |
| `protocol/` | `.alignyard/` manifest、文档创建/校验/索引与 `ay` 参数解析 |
| `repo/` | owner-local Git mirror、分支、worktree、Repository catalog 和环境构造 |
| `task/` | runtime Task 创建、引用、生命周期、manifest、图片粘贴与 `tdsp` 命令契约 |
| `session/` | Agent 参数、tmux、PTY、会话记录和 Claude hook |
| `fleet/` | 本地/SSH runner、远端 node client、安装/bootstrap、节点聚合与存活探测 |
| `network/` | Tailscale Serve/诊断/Peer Relay、节点配对和 profile 所有的 SSH identity |
| `onboarding/` | 网络、手机、供电/保持唤醒的实时状态 |
| `http/` | Express 组合、JSON 路由、静态文件和 WebSocket 终端桥接 |
| `provider/` | Anthropic 兼容 Provider 的检查、保存和安全投影 |
| `codeview/` | owner-local Repository/worktree 的只读 diff、树和文件检查 |

## 组合约定

- `http/routes.ts` 负责校验 HTTP 输入、选择本地或远端 runner、调用领域模块并映射状态码；新业务规则应优先进入相应领域模块。
- `tdsp.ts` 为 `runCli` 注入真实数据库、runner、tmux、Repository、Task、Provider 与网络操作；`task/cli.ts` 保持可注入、可测试。
- 节点间不会传递任意路径来代替 Repository ID。目标节点先从自身 catalog 解析对象，再执行 Git、tmux 或文件操作。
- 长任务运行状态不只看数据库：tmux session、worktree 是否存在和 Claude waiting marker 都由拥有节点实时探测。
- 跨节点 DTO 必须经过安全投影；本地路径、token、prompt、Provider ID 和底层 Git 错误不应出现在控制节点 UI。

## 主要持久化对象

`server/core/schema.ts` 同时维护两组关联但语义不同的表：

- `repos`、`tasks`、`task_references`、`hosts`、`providers`、`onboarding_events` 描述某个 Switchyard 节点的实际运行资源。
- `platform_repositories`、`platform_tasks`、`platform_task_repositories`、`platform_artifacts` 描述 Alignyard 的协作对象、状态、提交与版本化工程知识快照。

Platform Task 可通过 `runtime_task_id` 链接到一个本地 runtime Task，但两者不能混同：前者是需求/评审生命周期，后者是一次具体 worktree/tmux 执行。

## 进一步阅读

- 命令、环境变量和机器协议见 [CLI 与配置契约](cli-configuration.md)。
- 浏览器和节点接口见 [HTTP 与 WebSocket 契约](http-api.md)。
- `.alignyard/` 规则见 [Alignyard 工程知识协议](knowledge-protocol.md)。
- 端到端流程与持久化布局见 [架构与数据流](../shared/architecture.md)。

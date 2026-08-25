---
id: doc.switchyard.overview
title: "Switchyard 概览"
kind: doc
scope: switchyard
owners: []
relations:
  - doc.shared.overview
  - doc.shared.development-workflow
  - doc.switchyard.cli-configuration
  - doc.switchyard.node-task-protocol
  - doc.switchyard.http-realtime-api
---

# 概述

Switchyard 是本地优先的 AI Coding Agent 运行控制面。每台安装 Switchyard 的机器都是完整节点，并且是该机 Repository、任务、worktree、tmux 会话、Provider 配置和 Agent 进程的唯一所有者。浏览器或另一节点可以发起控制请求，但不会成为远端状态的替代真源。

支持的 Agent 是 `claude`、`codex` 和 `kimi`。所选 Agent、可选模型和 Provider 归属于任务，恢复任务时沿用；Provider 凭据只留在执行任务的节点。

## 运行架构

启动链路为 `tdsp serve` → `server/tdsp.ts` → 动态导入 `server/index.ts`。`server/index.ts` 创建 Express app，为每个请求的监听地址创建 HTTP server，再为其挂载 `/pty` WebSocket。所有 listener 成功绑定后才启动存活探测和 macOS 保活恢复；绑定失败会关闭已启动 listener，避免记录伪运行状态。

主要数据流如下：

1. 浏览器通过 REST 获取 Repository、任务、节点、Provider、onboarding 或 Alignyard 状态。
2. 本节点操作直接调用本地领域函数；远端操作通过已登记节点的准确 `tdsp` 路径和 SSH runner 下沉到目标节点。
3. 目标节点更新自己的 sqlite、Git mirror/worktree、tmux 和磁盘 manifest，再返回经过裁剪的 JSON。
4. 浏览器终端连接 `/pty?session=...`；服务端验证 session 名和可选 host，启动本地 tmux attach 或 SSH/mosh attach 的 PTY 转发。

远端访问推荐通过 Tailscale 私有 HTTPS。节点发现与首次双向连接使用 HTTPS 和同一 Tailscale 登录身份；真正的 Repository、任务、终端和文件操作依赖 SSH。没有安装 Switchyard 的远端不能接收任务。

## 组件边界

| 目录 | 稳定职责 |
|---|---|
| `server/core/` | 数据根、namespace、sqlite schema/迁移、归属查询、serve 生命周期 |
| `server/repo/` | Repository catalog、bare mirror、分支抓取、主 worktree |
| `server/task/` | 任务创建、引用仓库、manifest、生命周期和 `tdsp` 命令解析 |
| `server/session/` | tmux、PTY、Agent argv、恢复、transcript 和粘贴适配 |
| `server/fleet/` | 本地/SSH runner、节点列表、bootstrap、liveness、profile 安装卸载 |
| `server/network/` | Tailscale Serve、发现、握手、专用 SSH identity、诊断和 Peer Relay |
| `server/onboarding/` | 网络、手机、供电和多节点就绪状态的实时推导 |
| `server/http/` | REST、静态资源和 `/pty` WebSocket 装配 |
| `web/js/core/`、`web/js/features/` | 浏览器状态、任务/节点 UI、终端、移动端、阅读和引导 |

## 持久状态与恢复

默认基础数据根是 `~/.task-dispatcher`，`TASK_DISPATCHER_DATA_DIR` 可覆盖。每个实例在基础根中使用稳定 namespace，实际数据位于 `<base>/<namespace>/`，包含 `dispatcher.db`、`mirrors/`、`worktrees/`、`tasks/`、`repos.json`、SSH identity 和 serve 所有权记录。profile 使用独立数据根、namespace、socket、启动器与端口。

sqlite 使用 WAL。启动时 schema 会增量补齐旧列，并在明确检测到旧版项目内 `data/` 时执行一次路径迁移。`repos.json` 与每个任务目录下的 `task.json`/`workspace.json` 是节点自描述资料；数据库丢失时只能收养本节点已有且归属可验证的 manifest，不会收养远端控制器遗留记录。

## Web 界面边界

`web/index.html` 是 Switchyard 的节点/任务/终端界面；`web/platform.html` 是 Alignyard 共享工作区，并且当前由 `/` 直接提供。两套界面共享 `/pty`、代码检查和 owner-local 运行能力。`server/http/app.ts` 明确要求 Alignyard 的嵌入 Agent 工作区不依赖旧 Switchyard 产品 UI，因此新增共享能力应落在服务/领域模块，而不是跨页面互调。

## 安全边界

Web 终端等同于 shell 权限。默认仅绑定 `127.0.0.1`；可使用私有 tailnet、可信私有 CIDR 或自带认证的反向代理。不要把 `HOST=0.0.0.0` 直接暴露到公网：应用当前没有多用户认证。Repository token 与 Provider key 以明文保存在节点本地 sqlite，面向个人与可信机器；跨节点 DTO、manifest 和 UI 摘要必须剔除秘密值及 owner-private 路径。

## 相关知识

日常命令、环境变量和 profile 见 `doc.switchyard.cli-configuration`；节点归属、任务生命周期、worktree 和 manifest 不变量见 `doc.switchyard.node-task-protocol`；REST 与 WebSocket 见 `doc.switchyard.http-realtime-api`。

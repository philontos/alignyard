---
id: doc.shared.overview
title: "仓库概览"
kind: doc
scope: shared
owners: []
relations:
  - doc.shared.development-workflow
  - doc.switchyard.overview
  - doc.switchyard.cli-configuration
  - doc.switchyard.node-task-protocol
  - doc.switchyard.http-realtime-api
  - doc.alignyard.overview
  - doc.alignyard.knowledge-protocol
  - doc.alignyard.task-workflow
---

# 概述

本仓库是一个私有的 Node.js 22+、TypeScript ESM 应用，`package.json` 中的包名为 `task-dispatcher`。仓库同时承载两个明确的产品边界：Switchyard 负责在用户自己的开发机上运行和连接 AI Coding Agent；Alignyard 负责 Repository、Task、工程知识、Review 与合并请求协作。二者共用一个 Express/SQLite 进程和部分 owner-local 运行能力，但拥有不同的入口和长期契约。

代码没有编译产物或前端打包步骤。服务端 TypeScript 由 `tsx` 直接执行，浏览器端是 `web/` 下的静态 HTML、CSS 和原生 JavaScript。`node_modules/`、运行数据目录 `data/`、日志与系统文件不属于版本化工程知识。

## 产品与系统边界

| 边界 | 入口 | 持久状态 | 主要职责 |
|---|---|---|---|
| Switchyard | `server/tdsp.ts`、`server/index.ts`、`web/index.html` | 每个节点自己的 sqlite、mirror、worktree、tmux 会话和 manifest | 本地或跨节点派发任务、连接终端、管理 Agent 与网络 |
| Alignyard | `server/ay.ts`、`server/platform/`、`web/platform.html` | 平台 Repository/Task/artifact 表，以及各 Git 仓库中的 `.alignyard/` | 版本化工程知识、Task 协作、Review、PR/MR 与合并流程 |

`server/http/app.ts` 当前把 `/` 映射到 `web/platform.html`，因此 Alignyard 是共享 Web 进程的根页面；Switchyard 的成熟运行能力仍通过 `server/task/`、`server/fleet/`、`server/session/`、`server/network/` 和相应 API 被复用。不要把这两个边界误解为两个独立部署服务。

## 关键入口

- `server/index.ts`：进程启动入口。打开数据库、迁移旧路径、恢复本节点 manifest、创建 HTTP/WebSocket 服务并启动存活探测。
- `server/tdsp.ts`：`tdsp` CLI 的真实 IO 装配层；业务解析位于 `server/task/cli.ts`。
- `server/ay.ts`：`ay` CLI 的薄入口；协议实现在 `server/protocol/`。
- `server/http/app.ts` 与 `server/http/routes.ts`：静态页面、REST 路由和两个产品边界的共享服务面。
- `server/http/ws.ts`：浏览器终端到本地或已登记远端 tmux 会话的 `/pty` 桥接。
- `web/platform.html`、`web/js/platform.js`：Alignyard 共享工作区。
- `web/index.html`、`web/js/main.js`：Switchyard 节点、任务和终端界面。

## 目录约定

- `server/core/` 保存路径、sqlite schema、迁移、归属查询与本地化等基础能力。
- `server/repo/`、`server/task/`、`server/session/` 依次负责 Git mirror/worktree、任务生命周期、tmux/PTY/Agent 启动。
- `server/fleet/`、`server/network/`、`server/onboarding/` 负责节点传输、Tailscale/SSH 连接和设备就绪状态。
- `server/platform/` 与 `server/protocol/` 分别负责 Alignyard 平台工作流和版本化工程知识协议。
- `server/http/` 只装配服务边界；路由必须调用 owner-local 或平台领域能力，不应复制归属判断。
- `web/js/core/` 是浏览器共享基础能力，`web/js/features/` 是 Switchyard 功能模块，`web/js/platform*.js` 是 Alignyard 工作区。
- `scripts/readme-demo/` 仅生成确定性、脱敏的 README 截图；`docs/screenshots/` 是其版本化输出。
- `.alignyard/` 是随代码评审的工程知识，不是运行数据库或生成缓存。

## 知识导航

- 开发环境、测试、安装和交付见 `doc.shared.development-workflow`。
- Switchyard 的运行架构见 `doc.switchyard.overview`；命令与配置见 `doc.switchyard.cli-configuration`；节点和任务不变量见 `doc.switchyard.node-task-protocol`；HTTP 与实时终端见 `doc.switchyard.http-realtime-api`。
- Alignyard 的边界见 `doc.alignyard.overview`；`.alignyard` 与 `ay` 契约见 `doc.alignyard.knowledge-protocol`；平台 Task 生命周期见 `doc.alignyard.task-workflow`。

## 已核实的范围限制

仓库没有 `.github/workflows/`、GitLab CI、CircleCI 或 Jenkins 配置，也没有 npm publish 或制品发布脚本；`package.json` 明确为 `private: true`。当前交付方式是从源码 checkout 安装依赖和启动器，再由 `tdsp update` 快进更新。仓库也没有除双语 README 和截图以外的既有设计文档，因此本知识集以代码、测试和 README 的交集为事实依据。

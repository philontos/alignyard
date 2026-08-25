---
id: doc.shared.overview
title: "仓库概览"
kind: doc
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.shared.development
  - doc.server.overview
  - doc.server.cli-configuration
  - doc.server.http-api
  - doc.server.knowledge-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
---

# 概述

本仓库是 Alignyard 的单体 npm 工程，同时保留其节点本地执行底座 Switchyard。当前 HTTP 根路径由 `server/http/app.ts` 固定返回 `web/platform.html`，用于管理 Repository、Task、工程知识快照以及 Review/PR/MR/Merge 流程；任务真正执行时仍复用 Switchyard 的 Git mirror、隔离 worktree、tmux、PTY、Agent 和多节点能力。

`package.json` 中的包名仍为 `task-dispatcher`，README 主要介绍 Switchyard 的部署与远程节点能力。理解当前产品入口时以 `server/http/app.ts` 和 `web/platform.html` 为准，理解底层执行与运维时以 README、`server/task/`、`server/session/`、`server/fleet/` 和 `server/network/` 为准。

## 系统边界

| scope | 负责内容 | 主要入口 |
|---|---|---|
| `shared` | 跨前后端架构、数据流、开发和长期决策 | `package.json`、`README.md`、`README.zh-CN.md` |
| `server` | Express/HTTP、WebSocket、SQLite、Repository/Task 生命周期、平台工作流、CLI 与工程知识协议 | `server/index.ts`、`server/tdsp.ts`、`server/ay.ts` |
| `web` | 无构建步骤的浏览器界面、终端接入和交互状态 | `web/platform.html`、`web/js/platform.js`、`web/index.html`、`web/js/main.js` |

`server/` 内的领域目录和 `web/js/core/`、`web/js/features/` 是模块边界，不各自建立 scope；它们共同组成上述两个可独立理解的源码边界。

## 快速导航

- [架构与数据流](architecture.md)：平台 Task、节点 runtime、持久化、远端调用和安全边界。
- [开发、测试与运维](development.md)：环境要求、常用命令、测试、安装、更新和目录规范。
- [后端服务概览](../server/overview.md)：后端组合根、启动顺序和领域模块职责。
- [CLI 与配置契约](../server/cli-configuration.md)：`tdsp`、`ay`、环境变量、profile 和机器间 JSON 协议。
- [HTTP 与 WebSocket 契约](../server/http-api.md)：浏览器与服务端、节点终端之间的接口分组。
- [Alignyard 工程知识协议](../server/knowledge-protocol.md)：`.alignyard/`、文档语义、校验与同步规则。
- [浏览器应用概览](../web/overview.md)：当前 Alignyard 界面、保留的 Switchyard 界面和前端约定。
- [节点本地归属](../../adrs/shared/node-local-ownership.md)：Repository、凭据、worktree、tmux 与 Agent 的长期归属决策。

## 关键事实来源

- 产品能力和人工安装路径：`README.md`、`README.zh-CN.md`、`scripts/setup.sh`。
- 可执行命令和依赖：`package.json`、`server/task/cli.ts`、`server/protocol/cli.ts`。
- 运行时组合与 API：`server/index.ts`、`server/http/app.ts`、`server/http/routes.ts`、`server/http/ws.ts`。
- 数据模型和平台流程：`server/core/schema.ts`、`server/platform/catalog.ts`、`server/platform/workflow.ts`、`server/platform/sync.ts`。
- 前端入口与交互：`web/platform.html`、`web/js/platform.js`、`web/js/platform-agent.js`、`web/index.html`、`web/js/main.js`。
- 行为回归证据：`server/**/*.test.ts` 和 `web/**/*.test.mjs`。

## 已知命名边界

源码同时使用 Alignyard、Switchyard 与历史标识 `task-dispatcher`/`tdsp`。这些名称分别对应当前协作界面、节点执行产品和兼容命令/数据路径；维护时不要仅为统一名称而改写稳定标识。README 中个别能力说明可能落后于当前实现，例如根页面已切换到 Alignyard，因此行为判断应以当前代码和测试为最终证据。

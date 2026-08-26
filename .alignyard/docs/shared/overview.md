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
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
---

# 概述

本仓库是单一 Alignyard 产品的 npm 工程。云端 Platform 提供 Web、登录、Repository/Task/Review、工程知识与流程状态；用户本地 Runner 调用已有 Git、tmux、Agent 和 forge CLI 完成执行。仓库不再包含另一套本地控制台、Host fleet、Network、Provider 或源码浏览产品。

## 源码边界

| 目录 | 职责 | 约束 |
|---|---|---|
| `server/platform/` | 协作模型、工作流、Prompt、工程知识同步和云端组合根 | 不 import 本机 Git/worktree/tmux 实现 |
| `server/runner/` | 设备配对、连接、RPC 调度和本机 operations | 只执行协议 allowlist |
| `server/http/` | HTTP/WS 鉴权、参数与响应适配 | 不承载工作流状态机 |
| `server/repo/`、`task/`、`session/` | Runner 使用的 Git/worktree/tmux 执行内核 | 不依赖 Express 或 Platform 用户模型 |
| `server/protocol/` | `ay` 工程知识协议与 CLI | Repository 内可独立校验 |
| `server/core/` | SQLite、路径和小型基础抽象 | 不放产品流程 |
| `web/` | 唯一浏览器应用、Runner 安装引导与 execution 终端 | 不接收设备 token 或本机路径 |
| `scripts/` | 通用部署、Runner 构建和包内 launcher | 不包含特定云项目配置 |

## 唯一入口

- `npm start` / `server/platform/main.ts`：Platform。
- `npm run runner` / `server/runner/main.ts`：源码方式运行 Runner。
- `alignyard-runner`：正式 macOS Runner 管理命令。
- `ay` / `server/ay.ts`：Repository 工程知识命令。
- `web/platform.html`：唯一 Web 页面。

不存在 `tdsp`、本地一体化服务、旧 `index.html` 或按 Host/SSH/Tailscale 操作其他节点的入口。SQLite 中可能仍有历史兼容列，用于已有数据无损升级；它们不构成公开能力。

## 文档导航

- [架构与数据流](architecture.md)
- [开发、测试与运维](development.md)
- [后端服务概览](../server/overview.md)
- [CLI 与配置](../server/cli-configuration.md)
- [HTTP 与 WebSocket](../server/http-api.md)
- [Runner 安装与协议](../server/runner-protocol.md)
- [工程知识协议](../server/knowledge-protocol.md)
- [浏览器应用](../web/overview.md)

## 信息边界

`.alignyard/` 只保存可提交的通用工程知识，不保存运行实例数据。禁止写入真实用户身份、邮箱白名单、Google client ID、Platform session、Runner/device/execution token、pairing code、已登记 Repository/Task/Review 内容、本机绝对路径、云项目 ID、域名或部署密钥。示例必须使用占位值。

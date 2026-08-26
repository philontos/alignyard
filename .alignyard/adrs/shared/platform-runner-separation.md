---
id: adr.shared.platform-runner-separation
title: "单一 Alignyard 产品与 Platform/Runner 分离"
kind: adr
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.server.overview
  - doc.server.runner-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
---

# 背景

Alignyard 需要在云端提供用户、Repository、Task、Review、Prompt 和工程知识协作，又要复用用户电脑上的源码、Git 凭据、Agent 登录和开发工具。云端直接运行 Agent 会扩大凭据与源码边界；浏览器也不能在没有用户确认的情况下安装本机常驻程序。

早期代码来自本地执行工具，曾同时保留一套本地控制台和新的 Alignyard 实现。这造成两套入口、两套产品语义和大量仅为兼容存在的 Host、Network、Provider、源码浏览代码，不符合单一产品的维护目标。

# 决策

- 仓库只有一个产品：Alignyard。运行形态只有云端 Platform 与用户本地 Runner，不再保留独立的本地控制台、旧 CLI 或旧 Web/API 产品入口。
- `server/platform/main.ts` 是唯一服务端入口，负责身份、协作状态、Runner registry、有限 RPC、终端中继和 Web 静态资源。
- `server/runner/main.ts` 是唯一执行入口，负责 Repository mirror、worktree、tmux、Agent 和 GitHub/GitLab CLI 操作。
- 原有 Git、worktree、tmux、Agent 与工程知识代码被吸收为 Alignyard 执行内核；它们是内部模块，不是被保留的第二个产品。
- Web 通过一次性 pairing code 生成 macOS 安装命令。安装包自带 Node runtime 和 npm 依赖；git、tmux、Codex、Claude、Kimi、gh、glab 由用户自行安装和登录。
- Platform 使用 SQLite 单实例，并提供通用 Docker/Compose 部署。GCP VM 创建、SSH、上传和域名配置属于仓库外的操作者工具，不进入产品核心。
- 新功能必须落在 Platform、Runner 或执行内核的明确边界内，不得重新引入任意 shell RPC、Host fleet 或另一套本地 Web 服务。

# 影响

- 云端不 clone 用户 Repository，也不保存 Git、forge 或 Agent 凭据；用户电脑只需建立出站 WebSocket。
- Runner 离线时协作数据仍可读，但执行、分支查询和终端明确不可用，不回退到云端执行或其他用户设备。
- 自包含安装包会重复携带 Node，但消除了系统 Node 版本和 native module ABI 差异。首版只支持 macOS。
- 旧产品源码、页面、入口和依赖从仓库删除。SQLite 中少量历史列可为无损升级暂时保留，但不得被解释为仍支持旧产品。
- 当前安装包只有 SHA-256 校验，尚未签名、notarize 或自动更新；面向公开用户发布前必须补齐发布者身份验证、升级和回滚。

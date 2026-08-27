---
id: doc.web.overview
title: "浏览器应用概览"
kind: doc
scope: web
owners: []
relations:
  - doc.shared.architecture
  - doc.shared.development
  - doc.server.http-api
  - doc.server.runner-protocol
  - adr.shared.platform-runner-separation
---

# 概述

`web/` 是由 Platform 直接提供的唯一浏览器应用，使用原生 HTML/CSS/ES modules，无 bundler。入口为 `web/platform.html`；不存在第二套本地控制台。

## 能力

- Google 登录、退出和成员选择。
- 无凭据 Repository 登记、协议 refresh 与 Repository Init。
- change / repository_init Task 创建、筛选、详情和清理。
- 普通 Task 的知识设计 → Review → changes requested/可开始实现闭环，以及 Repository Init 的 PR/MR → merge 特殊闭环。
- 从当前用户自己的 Runner worktree 按需读取 Docs、Specs、ADRs、Plans，并展示设计基线；Git diff 仍在 worktree 中通过 Git 与 Agent 阅读。
- 当前用户 Runner 状态、macOS 安装与重新连接引导。
- 通过 execution ID 打开的本地 Agent 终端。

Web 不接收 Repository token、设备 token、本机路径或本地 Task ID，也不提供 Platform 侧 diff。Task 页面只能按需请求当前参与者自己的 Runner 解析 `.alignyard/` 文档，正文仅用于当次浏览，不写入 Platform 数据库；Reviewer 需先启动自己的 Review Agent，实际拉取和修改权限由 GitHub/GitLab 决定。

## Runner 安装引导

`web/js/features/runner-onboarding.js` 管理 Runner indicator、设备列表、pairing code 和安装 dialog；样式位于 `web/css/features/runner-onboarding.css`。

浏览器不能静默安装本机 daemon。页面生成包含当前 origin 和短期 pairing code 的命令，用户复制到 Terminal 明确执行。LaunchAgent 启动 Runner 后，页面轮询在线状态并自动结束引导。

安装文案必须说明：包内包含 Node runtime；git、tmux、Codex、Claude、Kimi、gh、glab 由用户自行准备。不得把 pairing code 写入日志、localStorage 或工程知识。

## Task 与终端

`web/js/platform-agent.js` 必须取得 `runner_execution_id`，并通过 `core/pty-socket.js` 连接 `/pty?execution=<id>`。没有 execution 时只展示不可用状态，不回退到 session/Host 参数。

终端断开只关闭浏览器 attach，tmux 继续运行。终端实现保留 resize、IME、断线和 xterm renderer fallback；错误必须明确区分未登录、Runner 离线、execution 不属于当前用户和 session 不存在。

## 模块约定

- `platform.js` 管理页面级导航与共享 state；完整新交互应拆成可独立初始化的 feature。
- `platform-agent.js` 只管理终端视图，不拥有 Task 工作流。
- `core/pty-socket.js` 只生成 execution-scoped WebSocket 和连接事件。
- `core/repo-details.js` 只格式化无凭据 Repository 摘要。
- `features/runner-onboarding.js` 只负责安装/设备引导。
- vendored xterm 文件固定在 `web/vendor/`，不从 CDN 动态加载。

当前 `web/js/platform.js` 仍较大，后续优先按 Repository surface、Task list、Task workspace 三个闭环拆分；拆分时保持一个 action 的状态、请求、错误和渲染在同一 feature 内。

## 验证

- 前端测试使用 `*.test.mjs`。
- `web/platform.tasks.test.mjs` 覆盖产品入口、流程动作和云端边界。
- 修改终端协议时同步运行 `pty-socket` 与 renderer 测试。
- 页面只允许引用实际存在的静态文件和 API，不保留已删除功能的隐藏按钮、CSS 或兼容 fallback。

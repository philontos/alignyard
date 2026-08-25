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
---

# 概述

`web/` 是由 Express 直接提供的无构建浏览器代码。当前存在两个页面入口：`platform.html` 是根路径 `/` 的 Alignyard 协作界面；`index.html` 是保留的 Switchyard 节点控制界面。两者共享 vendored xterm、部分 `web/js/core/` 能力和同一个后端进程，但页面状态与产品流程不同。

## Alignyard 页面

`web/platform.html` 引入 `web/css/platform.css`、xterm 资源与 `web/js/platform.js`。主要流程包括：

- Repository 列表、登记、删除、协议 refresh 与 Initialize。
- Task 列表、筛选、创建、详情、状态、run、Review、PR/MR、Merge 和删除。
- 工程知识 artifact 展示和任务关联 Repository 信息。
- `web/js/platform-agent.js` 在 Task drawer 内打开 runtime Agent 终端，通过共享 `core/pty-socket.js` 连接 `/pty`。

`platform.js` 在内存 `state` 中保存 repositories、tasks、当前 view 和筛选；初始加载并行请求 `/api/platform/repositories` 与 `/api/platform/tasks`。新增 Repository 时先调用本地 `/api/repos` 准备 owner-local mirror，再登记平台 Repository 并 refresh 协议状态。

## Switchyard 页面

`web/index.html` 与 `web/js/main.js` 组成原有节点控制台。`main.js` 负责启动基础 DOM、主题、语言、移动导航和全局桥接，再由 `web/js/features/` 分别加载：

- `repos.js`、`tasks.js`：本地/远端 Repository 与 Task 派发。
- `hosts.js`、`onboarding.js`：节点、Tailscale、SSH 配对、更新和设备就绪状态。
- `terminal.js`、`reading.js`、`codeview.js`：实时终端、会话阅读与代码检查。
- `providers.js`、`runtime-references.js`、`mobile.js`：Provider、引用 Repository 和移动交互。

该页面仍可通过显式 `/index.html` 获取，但不能假设它是 `/`。

## 前端模块约定

- 使用浏览器原生 ES modules，没有 React/Vue、bundler 或编译步骤。模块路径和全局脚本加载顺序由 HTML 直接决定。
- `web/js/core/` 放 API、DOM、dialog、state、PTY、代码视图和可复用状态机；`web/js/features/` 放 Switchyard 页面领域交互。
- `web/js/platform.js` 当前较集中，平台终端拆到 `platform-agent.js`；共享终端帧格式必须继续通过 `core/pty-socket.js`。
- `web/i18n.js` 与 `web/theme.js` 是经典脚本并向页面暴露全局能力。Alignyard 当前叙述固定使用中文，Switchyard 支持中英文切换。
- `web/vendor/` 保存 xterm 及 addons，Highlight.js 由固定 npm 依赖经服务端窄路径提供；不要临时改用外部 CDN。
- `web/assets/` 是产品图形资源，`docs/screenshots/` 是 README 截图脚本输出，不属于运行页面源码。

## 终端交互

浏览器把键盘数据直接发给 `/pty`；resize 使用 `\0resize:<cols>x<rows>`，批量提交文本使用 `\0submit:<json>`。Alignyard 与 Switchyard 终端均处理移动尺寸和中文 IME；Codex 额外启用 Unicode 适配。断开只关闭当前 attach，后台 tmux 任务继续运行。

## 测试与修改检查

前端测试与模块相邻，命名为 `*.test.mjs`，由 `npm test` 在 Node.js 中执行。现有覆盖包括 dialog、PTY socket、Task 生命周期、Repository 详情、host follow、阅读定位、codeview、移动导航、终端 Unicode 和 Alignyard platform Task 行为。

修改页面时至少检查：

1. `platform.html` 与 `index.html` 是否仍加载各自需要的脚本和样式。
2. 新 HTTP 调用是否处理非 2xx、错误正文和 loading/重复点击状态。
3. 终端改动是否保持 resize、IME、断线和 tmux 持久性语义。
4. 桌面与移动交互是否有对应定向测试；影响 README 展示时再运行截图流程。

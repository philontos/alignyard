---
id: doc.shared.development-workflow
title: "开发、测试与交付"
kind: doc
scope: shared
owners: []
relations:
  - doc.shared.overview
  - doc.switchyard.cli-configuration
  - doc.alignyard.knowledge-protocol
---

# 概述

仓库使用 npm lockfile、Node.js 22+ 和 `tsx`。服务端采用严格 TypeScript 配置，浏览器代码直接以原生 ESM/脚本形式加载。没有独立 build 阶段；开发与生产入口都直接运行源码，因此变更必须同时关注 Node 端测试和浏览器端测试。

## 环境要求

- 基础工具：Node.js 22+、npm、`git`、`tmux`、zsh。
- `scripts/setup.sh` 当前会预检 `claude`、`kimi`、`tmux` 和 `git` 在非交互 `zsh -c` 中可见；`codex` 是可选 Agent，使用前需单独确认可见。
- Tailscale 是可选的系统依赖，用于私有 HTTPS、发现和节点身份；它不是 npm 依赖。
- `npm run screenshots:readme` 需要 Chrome；默认位置不可用时通过 `CHROME_BIN` 指定。

不要在测试或开发实例上复用正在运行的正式数据目录。使用 profile，或设置 `TASK_DISPATCHER_DATA_DIR` 指向隔离目录。

## 常用开发命令

| 命令 | 作用 |
|---|---|
| `npm install` | 按 `package-lock.json` 安装依赖，并修复 `node-pty` 的 `spawn-helper` 执行位 |
| `npm run dev` | 以 `tsx watch server/index.ts` 启动监听开发进程 |
| `npm start` | 以 `tsx server/index.ts` 启动共享 Web 服务 |
| `npm run -s tdsp -- <参数>` | 从当前 checkout 运行 `tdsp` CLI |
| `npm run -s ay -- <参数>` | 从当前 checkout 运行 `ay` CLI |
| `npm test` | 使用 Node test runner 执行 `server/**/*.test.ts` 与 `web/**/*.test.mjs` |
| `npm run screenshots:readme` | 运行一次性 mock 服务和无头 Chrome，刷新 `docs/screenshots/` |

`tsconfig.json` 覆盖 `server/**/*.ts`，启用 `strict`，目标为 ES2022；仓库没有单独的 `typecheck` script。新增官方检查命令前应更新 `package.json`，不要把临时本地命令写成既有契约。

## 测试组织

服务端测试与被测模块同目录，广泛使用内存 sqlite、临时目录和注入的 runner/IO，避免打开真实数据库、tmux 或远端节点。浏览器测试是 `web/**/*.test.mjs`，覆盖终端、移动端、导航、任务动作和代码预览等模块。高风险协议均有定向测试：

- `server/core/`：schema 兼容、路径隔离、归属与 serve 生命周期。
- `server/repo/`、`server/task/`：mirror/worktree、引用仓库、manifest 和任务生命周期。
- `server/fleet/`、`server/network/`：SSH 参数安全、节点身份、Tailscale 与 profile 卸载。
- `server/platform/`、`server/protocol/`：Alignyard 状态机、知识同步、Forge 工作流和 `.alignyard` 校验。
- `web/js/`：DOM 交互、终端输入、Unicode、移动端和任务界面。

改动领域逻辑时优先沿用依赖注入和临时资源模式。测试不应读取 `~/.task-dispatcher`、真实凭据或用户 tmux 会话。

## 安装与本机运行

`./scripts/setup.sh --check` 是只读预检；不带参数时脚本可幂等地修补 `~/.zshenv` 中带标记的 PATH 块、执行 `npm install`，并安装全局 `tdsp` 与 `ay` 启动器。脚本不安装 Node.js 或缺失的 Agent 二进制。

完成安装后使用 `tdsp serve`，默认监听 `127.0.0.1:4500`。需要并行验证时，使用 `tdsp install --profile <name>` 创建隔离数据根、namespace、启动器和端口；安装 profile 本身不会启动服务。

## 截图维护

README 截图由 `scripts/readme-demo/server.mjs`、`data.mjs` 和 `capture.mjs` 生成。该流程连接真实前端但使用一次性 mock 数据，不打开真实 Switchyard sqlite 或 tmux；输出写入 `docs/screenshots/`。更新相关 UI 后，应运行截图命令并评审图像是否确定、脱敏且与双语 README 一致。

## 交付与更新

仓库当前没有 CI、打包、npm publish、容器镜像或版本发布配置。源码安装的更新路径是 `tdsp update`：它定位已安装 checkout，执行 `git pull --ff-only` 和 `npm install --no-fund --no-audit`，然后提示重启服务。运行中的进程不会自动加载新代码；使用 `tdsp serve restart` 或重新运行 `tdsp serve`。

知识变更随 Git 提交评审。新建或修改 `.alignyard` 文档后先运行 `ay validate .`，与 Alignyard Task 关联时再运行 `ay sync`。不得把运行数据库、token、Provider key 或用户机器绝对路径提交到仓库。

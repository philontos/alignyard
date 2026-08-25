---
id: doc.shared.development
title: "开发、测试与运维"
kind: doc
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.server.cli-configuration
  - doc.server.knowledge-protocol
  - doc.web.overview
---

# 概述

本仓库使用 Node.js 22+、TypeScript/ES modules 与直接加载的浏览器 JavaScript。没有编译产物或 bundler：服务端由 `tsx` 直接执行 `.ts`，浏览器端由 Express 原样提供 `web/`。`package-lock.json` 是依赖锁定文件，安装使用 npm。

## 环境准备

README 声明基础依赖为 Node.js 22+、`git`、`tmux` 与 zsh。`scripts/setup.sh` 还会按 tmux/SSH 使用的非交互 zsh 环境检查 `claude` 和 `kimi`，必要时在 `~/.zshenv` 写入带 marker 的 PATH 段，再运行 `npm install` 和 `tdsp install`。脚本不安装缺失的系统命令；`codex` 是可选 Agent，使用前单独确认 `zsh -c` 可找到它。

首次开发可使用：

```sh
npm install
npm run dev
```

`npm run dev` 执行 `tsx watch server/index.ts`。默认页面为 `http://127.0.0.1:4500`；如机器已有正式实例，应使用 `TASK_DISPATCHER_DATA_DIR` 和未占用端口隔离开发数据。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | watch 模式启动 `server/index.ts` |
| `npm start` | 直接启动 `server/index.ts` |
| `npm run -s tdsp -- <命令>` | 从源码调用节点运行与运维 CLI |
| `npm run -s ay -- <命令>` | 从源码调用 Alignyard 工程知识 CLI |
| `npm test` | 运行全部 `server/**/*.test.ts` 与 `web/**/*.test.mjs` |
| `npm run screenshots:readme` | 用临时 mock 服务和 headless Chrome 重建 README 截图 |
| `./scripts/setup.sh --check` | 只读检查非交互 zsh 所需命令，不安装或写文件 |
| `./scripts/setup.sh` | 修复 PATH、安装 npm 依赖，并安装全局 `tdsp`/`ay` 启动器 |

仓库没有独立 `build`、类型检查、lint 或 package 发布脚本。`tsconfig.json` 对 `server/**/*.ts` 启用 `strict`，但现有标准验证入口是 `npm test`；不要把不存在的 CI 门禁当作已配置流程。

## 测试约定

- 后端测试与源码同目录，命名为 `*.test.ts`，使用 Node.js 内置 test runner 并通过 `--import tsx` 加载 TypeScript。
- 前端测试命名为 `*.test.mjs`，同样由 Node.js test runner 执行；测试通常用轻量 DOM/socket 替身覆盖核心交互，不需要浏览器构建步骤。
- 领域逻辑优先通过依赖注入测试，例如 runner、数据库、文件探测和网络请求；涉及 SQLite 时使用临时或内存数据库，避免接触真实 profile。
- 改动 `.alignyard/` 时额外运行 `ay validate .`；这只验证协议结构，仍需人工检查主题完整性和事实依据。

## 截图维护

`scripts/readme-demo/server.mjs` 用确定性的 mock 数据提供真实 `web/`，`scripts/readme-demo/capture.mjs` 通过 Chrome DevTools Protocol 驱动桌面和移动流程，并写入 `docs/screenshots/`。该流程不打开真实 SQLite 或 tmux。Chrome 不在默认位置时设置 `CHROME_BIN`；截图是脚本生成物，不应手工修改。

## 安装、更新与运行

- `tdsp install` 在 `~/.task-dispatcher` 下准备源码链接和启动器；`tdsp install --profile <name>` 创建隔离的数据目录、namespace、端口使用环境与 `tdsp-<name>` 命令，但不会启动服务。
- `tdsp serve` 启动服务，`tdsp serve status|stop|restart` 管理同一 launcher/profile 的进程状态。
- `tdsp update` 对已安装 checkout 执行 `git pull --ff-only` 和 `npm install --no-fund --no-audit`；更新后需重启服务。仓库没有 tag 驱动、制品上传或自动部署流程。
- profile 卸载默认把完整数据移到 `~/.task-dispatcher/uninstalled-profiles/`；只有显式 `--purge` 才永久删除。默认 canonical 安装不能通过此命令移除。
- 当前仓库未跟踪 `.github/workflows/`、`.gitlab-ci.yml` 或同类 CI 配置，因此评审前必须在本地执行相关验证。

## 目录与代码约定

- `server/index.ts` 只做组合和启动；HTTP 胶水放在 `server/http/`，业务规则放在领域目录。
- 服务端 TypeScript 是 ESM，源码 import 使用运行时 `.js` 后缀；新增代码保持现有约定。
- `web/js/core/` 放可复用状态、DOM、PTY 和代码阅读能力，`web/js/features/` 放 Switchyard 页面功能；Alignyard 当前入口使用 `web/js/platform.js` 与 `web/js/platform-agent.js`。
- 稳定行为应有同目录测试；README 截图只通过 `screenshots:readme` 更新。
- `node_modules/`、运行数据 `data/`、日志和 `.DS_Store` 已忽略。凭据值不得写入日志、文档或 fixture。

## 提交前检查

1. 运行与改动范围相称的定向测试，再运行 `npm test`。
2. 若改动工程知识，运行 `ay validate .` 并检查 overview 导航、scope 覆盖与 relation。
3. 若改动 README 关键界面，运行 `npm run screenshots:readme` 并检查确定性输出。
4. 用 `git status --short` 确认没有 profile 数据、依赖、日志或其它生成物进入提交。

---
id: doc.server.cli-configuration
title: "CLI 与配置"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.overview
  - doc.shared.development
  - doc.server.overview
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
---

# 概述

Alignyard 只有两个 CLI：`alignyard-runner` 管理用户本地 Runner，`ay` 管理 Repository 内 `.alignyard/` 工程知识。开发 checkout 可用 `npm run runner -- ...` 与 `npm run -s ay -- ...`；正式安装包提供自包含 launcher。

## Runner 命令

| 命令 | 语义 |
|---|---|
| `alignyard-runner pair --platform URL --code CODE [--name NAME]` | 用一次性 code 绑定设备并写配置，不安装 LaunchAgent |
| `alignyard-runner install --platform URL --code CODE [--name NAME]` | 绑定设备并安装/启动 macOS LaunchAgent |
| `alignyard-runner start` | 前台连接 Platform；正式安装通常由 LaunchAgent 调用 |
| `alignyard-runner status` | 输出当前绑定的 Runner ID、名称和 Platform URL，不输出 token |
| `alignyard-runner doctor` | 检查 OS、git、tmux、Agent 与 gh/glab capability |

首版只为 macOS 自动安装 LaunchAgent。Runner 不提供任意 shell、Host 管理、网络配置或 Provider 管理命令。

## 工程知识命令

| 命令 | 语义 |
|---|---|
| `ay init [repository]` | 幂等创建最小 `.alignyard/` 骨架，不覆盖已有文件 |
| `ay update [repository] [--check]` | 预览或应用当前 Runner 内置的知识框架版本；只更新管理文件，不覆盖知识正文 |
| `ay new <doc|spec|adr|plan> <slug> --scope <scope> [--title TITLE]` | 从模板创建文档或可选技术方案 |
| `ay validate [repository] [--json]` | 校验 manifest、模板、Skill、路径、章节、ID 和 relations，并报告协议/框架版本 |

`ay` 只操作当前 Repository，不连接 Platform，也不上传知识或摘要。`ay init` 不覆盖现有骨架；已初始化 Repository 应先用 `ay update --check` 预览，再用 `ay update` 升级管理文件并由 Agent 整理知识。用户提交 Review 时，Runner 会再次运行 `ay validate`、检查 worktree 与提交并 push 当前工作分支。

## Platform 配置

| 变量 | 含义 |
|---|---|
| `HOST` / `PORT` | 监听地址与端口；容器默认 `0.0.0.0:4500` |
| `ALIGNYARD_DATA_DIR` | SQLite 与服务数据目录；容器使用 `/data` |
| `ALIGNYARD_AUTH_MODE` | `local` 或 `google` |
| `GOOGLE_CLIENT_ID` | Google Identity Services client ID |
| `ALIGNYARD_ALLOWED_EMAILS` | Google 登录 allowlist；值只放部署环境 |
| `ALIGNYARD_AUTH_ALLOW_ANY_GOOGLE` | 显式设为 `1` 时允许任意已验证 Google 邮箱 |
| `ALIGNYARD_API_TOKEN` | 可选的受信自动化 service token，不用于浏览器 |
| `ALIGNYARD_TRUST_PROXY` | Express 受信代理范围，影响 secure cookie 判断 |
| `ALIGNYARD_RUNNER_ARTIFACT_DIR` | Runner 下载制品根目录，默认 `dist/runner` |

`TASK_DISPATCHER_DATA_DIR` 仅作为旧数据目录环境变量的升级别名被代码读取；新部署和文档统一使用 `ALIGNYARD_DATA_DIR`。

## Runner 配置

| 变量或文件 | 含义 |
|---|---|
| `~/.alignyard/runner.json` | Platform URL、Runner ID、设备 token 与名称；权限 `0600` |
| `ALIGNYARD_RUNNER_CONFIG` | 测试时覆盖配置文件路径 |
| `ALIGNYARD_RUNNER_BIN` | 安装 LaunchAgent 时覆盖 launcher 路径 |
| `ALIGNYARD_DATA_DIR` | Runner SQLite、mirror 和 worktree 根目录 |

Launcher 扩充固定 PATH，以发现常见 Homebrew 与系统命令，但不会修改用户 shell profile。Agent、Git 和 forge 登录仍由用户自己维护。

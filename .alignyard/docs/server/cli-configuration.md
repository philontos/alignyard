---
id: doc.server.cli-configuration
title: "CLI 与配置契约"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.development
  - doc.server.overview
  - doc.server.http-api
  - doc.server.knowledge-protocol
  - adr.shared.node-local-ownership
---

# 概述

仓库提供两个稳定 CLI：`tdsp` 管理节点运行时、网络和安装，`ay` 管理 Repository 内版本化工程知识。开发 checkout 可分别用 `npm run -s tdsp -- ...` 与 `npm run -s ay -- ...` 调用；`tdsp install` 会安装全局启动器。

## 面向操作者的命令

| 命令组 | 稳定用途 |
|---|---|
| `tdsp serve [--port N] [--host IP|--hosts IPS|--host-cidr CIDR] [--tailscale]` | 启动 HTTP/PTY 服务；默认 `127.0.0.1:4500` |
| `tdsp serve status|stop|restart [--json]` | 管理当前 launcher/profile 的受管进程 |
| `tdsp network status|setup|diagnose <peer>|off [--json]` | 检查和管理 Tailscale Serve 路径 |
| `tdsp network relay enable [--port N]|disable [--json]` | 管理 Tailscale Peer Relay listener；tailnet grant 仍需管理员配置 |
| `tdsp create-local [--cwd PATH] [--title TEXT]` | 创建不绑定 Repository 的本地 tmux shell |
| `tdsp list` | 输出当前节点 Repository、Task、liveness 和 capabilities 的 JSON envelope |
| `tdsp doctor legacy [--json]` | 只读审计旧版本遗留的远端归属记录 |
| `tdsp install [--profile NAME]` | 安装 canonical 启动器或隔离 profile，不启动服务 |
| `tdsp uninstall --profile NAME [--purge] [--json]` | 归档或显式永久删除一个已停止 profile；不能移除 canonical 安装 |
| `tdsp update [--json]` | 对已安装 checkout 做 fast-forward 更新并刷新 npm 依赖 |

Repository/Task/Provider 的大部分命令是 HTTP 服务跨节点调用的机器接口，包括 `create`、`add-reference`、`repo-*`、`rename`、`stop`、`resume`、`cleanup`、`delete-task`、`paste-image`、`providers-*`、`inspect-code` 和 `transcript`。它们输出 JSON，调用方应以退出码、`ok` 和语义错误字段判断结果，不应解析人类日志。

## 节点间命令协议

- `tdsp list` 当前 `schema_version` 为 `3`，并返回 capabilities。读取方接受较旧的加法兼容 payload；遇到比自身更新的版本会标记 `version`，不会猜测字段。
- `create`、`repo-create`、Provider 写入、代码检查和 transcript 等复杂请求使用 base64 编码 JSON 参数，以便经 SSH argv 安全传递多行文本。`paste-image` 的二进制内容从 stdin 读取。
- Repository ID、Task ID 和 Provider ID 都属于目标节点自己的 catalog。控制节点只能转发目标节点已公开的 ID，不能把自己的文件路径当作远端输入。
- `list` 和控制操作由 `server/fleet/nodeclient.ts` 通过目标节点保存的准确 `tdsp_bin` 执行；未知命令用于识别旧节点 capabilities 缺失并安全降级。
- 跨节点返回会移除 token、mirror/worktree 路径、prompt、Provider ID 和原始文件错误。详细诊断只留在拥有节点。

## 工程知识命令

| 命令 | 契约 |
|---|---|
| `ay init [repository]` | 幂等创建最小 `.alignyard/` 骨架，不覆盖已有文件 |
| `ay new <doc|spec|adr> <slug> --scope <scope> [--title TITLE]` | 从仓库模板创建一个文档，scope 必须已声明 |
| `ay validate [repository] [--json]` | 校验 manifest、模板、Skill、文档、路径、必需章节、ID 和 relations |
| `ay sync [repository] --platform URL --task AY-KEY --repository-id ID [--base-commit COMMIT]` | 校验后把完整知识快照及相对基准的变更类型发布到 Platform Task |

`ay sync` 的选项也可由 `AY_PLATFORM_URL`、`AY_TASK_KEY`、`AY_REPOSITORY_ID`、`AY_BASE_COMMIT` 提供；`AY_API_URL` 是平台地址兼容名。存在 `AY_SESSION_TOKEN` 时，客户端发送 `Authorization: Bearer ...`。协议细节见 [Alignyard 工程知识协议](knowledge-protocol.md)。

## 运行配置

| 名称 | 含义与边界 |
|---|---|
| `PORT` | HTTP 端口，默认 `4500` |
| `HOST` / `HOSTS` | 单个或逗号分隔的监听地址；默认 loopback。不要把 `0.0.0.0` 裸露到公网 |
| `TASK_DISPATCHER_DATA_DIR` | 覆盖 `~/.task-dispatcher` 基础数据目录，用于开发/测试隔离 |
| `TDSP_SOURCE_DIR` / `TDSP_BIN` | 已安装源码与 launcher 的准确路径，更新和 profile 管理使用 |
| `TDSP_RESTART_ARGS` | `tdsp serve` 保存的重启参数，供 restart/自更新恢复相同监听选项 |
| `TDSP_TAILSCALE_SERVE` / `TDSP_TAILSCALE_PORT` / `TDSP_TAILSCALE_URL` | 成功启用 Tailscale Serve 后发布本节点 descriptor 与探测地址 |
| `TAILSCALE_BIN` | 覆盖 Tailscale 可执行文件位置 |
| `CHROME_BIN` | README 截图脚本使用的 Chrome 路径 |
| `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` | Claude 兼容 Provider 启动环境；值来自拥有节点本地 Provider 记录 |

`PATH`、`HOME`、`GIT_SSH_COMMAND`、`KIMI_CODE_HOME` 等由 launcher、runner 或 Agent 适配层传递，属于进程执行环境，不是跨节点配置文件。文档和日志只应引用秘密变量名称，不记录其值。

## Profile 与数据布局

canonical 安装和每个命名 profile 拥有独立的基础目录、namespace、SQLite、Git mirror/worktree、SSH key、socket、launcher 与 serve 生命周期记录。profile 名只能由 1 至 32 个小写字母、数字或连字符组成。`install --profile` 仅准备资源；调用者需选择未占用端口再执行对应的 `tdsp-<profile> serve`。

---
id: doc.switchyard.cli-configuration
title: "tdsp CLI 与配置"
kind: doc
scope: switchyard
owners: []
relations:
  - doc.switchyard.overview
  - doc.switchyard.node-task-protocol
  - doc.shared.development-workflow
---

# 概述

`server/tdsp.ts` 是 `tdsp` 可执行入口，只负责把真实数据库、runner、tmux、网络和文件 IO 注入 `server/task/cli.ts` 的 `runCli`。命令面同时服务直接使用者和节点间 SSH 控制；自动化命令以 JSON 和退出码作为契约。

## 服务与网络命令

| 命令 | 契约 |
|---|---|
| `tdsp serve [--port N] [--host IP\|--hosts IPS\|--host-cidr CIDR] [--tailscale [--tailscale-port N]]` | 启动共享服务；默认 `127.0.0.1:4500`，多个 listener 必须全部成功 |
| `tdsp serve status [--json]` | 查询当前 profile 管理的精确进程与启动参数；未运行时退出非零 |
| `tdsp serve stop [--json]` | 只停止 token/命令匹配的当前 profile 进程；已停止视为成功 |
| `tdsp serve restart` | 复用最近保存的受管启动参数；没有历史启动记录时拒绝 |
| `tdsp network status [--json]` | 查看 Tailscale 身份、Serve 和 peer 状态 |
| `tdsp network setup ...` | 为本地端口配置一个私有 HTTPS listener，不覆盖已有 Serve/Funnel 路由 |
| `tdsp network diagnose <peer> [--json]` | 判断 direct、peer-relay 或 DERP 路径及 UDP 状态 |
| `tdsp network off ...` | 只移除参数匹配且由当前实例拥有的 Serve 路由 |
| `tdsp network relay enable [--port N]` / `disable` | 管理 Tailscale Peer Relay listener |

`--host-cidr` 会同时保留回环地址并选择该 CIDR 内的本机 IPv4。Tailscale 模式保持应用回环监听，由 Tailscale Serve 提供私有 HTTPS，不启用 Funnel。

## Repository 与任务命令

面向人员的入口包括 `tdsp list`、`create-local`、`stop`、`resume`、`cleanup`、`delete-task`、`rename`、`install`、`uninstall`、`update` 与 README 中的 Repository/网络命令。以下命令也是跨节点协议，不宜随意改变输出形状：

- `tdsp list` 始终输出带 `schema_version`、`capabilities`、`tasks`、`repos` 的 JSON；远端 fleet 聚合依赖此契约。
- `tdsp create-local --cwd <路径> --title <标题>` 在本节点创建不绑定 Repository 的 tmux shell。
- `tdsp create <base64-json>`、`add-reference <task-id> <base64-json>`、`repo-create <base64-json>` 是控制器到 owner 节点的结构化命令。
- `repo-fetch <id>`、`repo-branches <id>`、`repo-delete <id> [--force]` 只操作本节点 catalog。
- `inspect-code <base64-json>` 与 `transcript <base64-json>` 是只读、类型化的跨节点查询，输出规范化 JSON，不泄露目标文件系统诊断。
- `providers-list/test/create/delete` 管理本节点 Provider；列表和远端结果只返回安全摘要。
- `paste-image <task-id> <mime>` 从 stdin 读取图像；`rename` 只改显示标题，不改 tmux session 或 Git 分支。
- `stop` 结束会话但保留 worktree；`cleanup` 移除引用和主 worktree；`delete-task` 在任何 worktree 仍存在时拒绝删除记录。
- `tdsp doctor legacy [--json]` 只读检查旧版远端归属与孤儿数据，不自动迁移或删除。

成功通常退出 `0`，校验、未找到、不可达或操作失败退出非零。跨节点调用方应读取 JSON 的 `ok`/`error`，不能只解析人类可读 stderr。

## 安装、profile 与更新

`tdsp install` 安装 canonical 启动器和 `ay`；`tdsp install --profile <name>` 创建 1–32 位小写字母、数字或连字符命名的隔离 profile，但不启动服务。`tdsp uninstall --profile <name>` 要求 profile 已停止，默认将完整 profile 移到 `~/.task-dispatcher/uninstalled-profiles/`，只删除匹配的启动器；`--purge` 才永久删除归档数据。canonical 安装不能通过该命令卸载。

`tdsp update` 仅对安装 checkout 执行 `git pull --ff-only` 和 npm 依赖刷新；如果 checkout 分叉会失败而不是合并。更新后必须重启服务才能加载新代码。

## 配置入口

| 名称 | 作用与约束 |
|---|---|
| `TASK_DISPATCHER_DATA_DIR` | 覆盖默认基础数据根，用于隔离开发或测试实例 |
| `PORT` | 默认 HTTP 端口，缺省为 `4500`；`tdsp serve --port` 优先 |
| `HOST` / `HOSTS` | 监听单地址或逗号分隔多地址；缺省仅回环 |
| `TDSP_SOURCE_DIR` | 安装启动器定位源码 checkout；`tdsp update` 的回退位置是 `~/.task-dispatcher/src` |
| `TDSP_BIN` | 节点发现和控制时公布的准确 `tdsp` 启动器路径 |
| `GIT_SSH_COMMAND` | Git SSH 调用覆盖；缺省启用 batch mode 和连接超时 |
| `KIMI_CODE_HOME` | transcript 读取 Kimi 状态时覆盖默认目录 |
| `CHROME_BIN` | README 截图流程覆盖 Chrome 路径 |

`TDSP_RESTART_ARGS`、`TDSP_TAILSCALE_SERVE`、`TDSP_TAILSCALE_PORT`、`TDSP_TAILSCALE_URL` 是进程内部衔接 serve/onboarding 的运行变量，通常由 `tdsp` 设置，不是持久用户配置。Provider 的 `ANTHROPIC_*` 值从节点 sqlite 注入 Claude 子进程；文档和日志只可引用变量名，不能记录值。

## 兼容性要求

`tdsp list` 和 task manifest 采用只增不破坏的版本契约：新 reader 可以读取旧 payload，遇到高于自身支持版本的 payload 必须报告 `version` 而不是猜测。新增跨节点能力应加入 `capabilities`，老节点缺少命令时应显式降级；禁止把本地绝对路径、token 或完整数据库行加回远端 DTO。

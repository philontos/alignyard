---
id: doc.shared.architecture
title: "架构与数据流"
kind: doc
scope: shared
owners: []
relations:
  - doc.server.overview
  - doc.server.http-api
  - doc.server.knowledge-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
---

# 概述

Alignyard 由一个 Node.js 进程同时提供静态浏览器应用、JSON API 与 `/pty` WebSocket，并把协作层的 Platform Task 连接到节点本地的 runtime Task。`server/index.ts` 是服务组合根，`server/http/app.ts` 将 `/` 指向 Alignyard，`server/platform/` 管理协作对象，原有 Switchyard 领域模块负责实际 Git、tmux、Agent、节点和网络操作。

## 运行边界

```text
浏览器 web/platform.html
        │ HTTP JSON / WebSocket
        ▼
server/http/* ──► server/platform/* ──► platform_* 表
        │                  │
        │                  └──► 工程知识快照 platform_artifacts
        ▼
repo/task/session 领域 ──► Git mirror + worktree + tmux + Agent
        │
        └── fleet/network ──SSH──► 远端节点的 tdsp 与本地状态
```

服务端进程不包含独立队列或外部数据库。SQLite、文件系统、Git、tmux 和本机命令是主要运行依赖；浏览器端直接加载仓库内的静态 HTML、CSS、ES modules 与 vendored xterm 文件。

## Repository 初始化数据流

1. 浏览器先通过 `/api/repos` 在本机登记并准备 Git mirror，再通过 `/api/platform/repositories` 建立契约上不含凭据的平台 Repository 行。
2. `/api/platform/repositories/:id/initialize` 创建 `repository_init` 类型的 Platform Task。`server/platform/workflow.ts` 生成初始化提示，并用 `createRepoTask` 从目标分支创建稳定工作分支、隔离 worktree 与 runtime Task。
3. tmux 持有 Agent 进程；浏览器的内嵌终端通过 `/pty?session=...` 附着，关闭页面不会终止任务。
4. Agent 在 worktree 内维护 `.alignyard/`，提交后执行 `ay sync`。客户端先本地校验和索引文档，再把 manifest、全文、SHA-256、基准提交、当前提交和变更类型发送到 `/api/platform/tasks/:key/sync`。
5. 服务端校验 scope、frontmatter、关系、大小和初始化中文要求，在事务中更新 `platform_artifacts` 与 Task-Repository 的提交状态。内容变化会把对应 artifact 的 `review_status` 重置为 `unreviewed`。
6. 提交 Review 前，工作流要求 worktree 干净、HEAD 不等于基准提交，而且平台记录的 `head_commit` 与 HEAD 一致。随后停止 runtime 会话；人工批准后才通过本机 `gh` 或 `glab` 推送并创建 PR/MR，合并后从默认分支重新检查初始化基线并清理 runtime worktree。

## 普通节点任务数据流

Switchyard 界面或 HTTP API 把 Repository Task 交给拥有该 Repository 的节点。目标节点解析自身 catalog 中的 Repository ID，更新 mirror，固定 `base_commit`，创建 `worktrees/<task>` 与工作分支，再启动选定的 `claude`、`codex` 或 `kimi`。附加 Repository 固定到准确 commit，以 detached worktree 放在 `worktrees/refs/<task-id>/<alias>`，并写入任务的 `workspace.json`。

控制节点读取远端状态时运行 `ssh <node> <tdsp_bin> list --json`；修改操作也调用远端 `tdsp` 命令。每个结果携带版本和 capabilities，单个节点离线或协议不兼容只影响该节点，不回退到控制节点的数据。

## 持久化与恢复

- `server/core/paths.ts` 默认把基础目录设为 `~/.task-dispatcher`，再用稳定 namespace 分隔实例；`TASK_DISPATCHER_DATA_DIR` 可覆盖基础目录。
- namespace 下的 `dispatcher.db` 使用 SQLite WAL；schema 同时保存本地 runtime 表与 `platform_*` 协作表。
- Git mirror、任务 worktree、引用 worktree、`repos.json`、Task manifest、SSH key、socket 和启动状态均属于当前 profile。
- 启动时会迁移旧 `./data`、同步 Repository manifest、从磁盘收养缺失的 Task manifest、回填本机 Task manifest，并在监听成功后启动节点存活探测与 keep-awake 恢复。
- tmux 是会话真源；数据库和 worktree 仍在但 tmux 丢失时，Resume 使用原 Agent、模型、Provider 和引用目录重建会话。

## 安全与信任边界

- 默认仅监听 `127.0.0.1:4500`。Tailscale Serve 提供 tailnet 私有 HTTPS；现有私网可通过 `--host-cidr` 增加选定地址。
- Web 终端等同 shell 权限，服务当前没有应用层多用户认证。不得把 `HOST=0.0.0.0` 直接暴露到公网。
- Repository token 与 Provider key 留在拥有节点的本地 SQLite，跨节点列表会再次投影字段，去掉 token、路径、prompt 和 Provider 信息。
- Platform Repository 的 `git_url` 当前只做非空校验，创建接口不会剥离 URL 内嵌凭据；credential-free 仍是调用方必须遵守的契约。不得向 `/api/platform/repositories` 提交带用户名、密码或 token 的 URL。
- Tailscale 负责身份、发现和私有可达；HTTPS 用于页面、探测和首次双向配对；真实远端 Repository、Task、终端与文件操作通过 SSH 在目标节点执行。
- 平台 Repository 行只保存定位和协议状态，不承担 clone、凭据或 worktree 的所有权。详见 [节点本地归属](../../adrs/shared/node-local-ownership.md)。

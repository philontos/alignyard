---
id: adr.shared.node-local-ownership
title: "Runner 本地资源归属"
kind: adr
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.server.overview
  - doc.server.runner-protocol
  - adr.shared.platform-runner-separation
---

# 背景

Repository checkout、Git/SSH/forge 凭据、worktree、tmux session 和 Agent 登录天然属于执行机器。若 Platform 保存或推断本机路径、复制凭据，断线、权限泄漏和状态漂移会产生多个互相冲突的真源。

# 决策

- Runner 永久拥有本地 Repository mirror、凭据、runtime Task、worktree、tmux session、Agent 与文件操作。
- Platform Repository 只保存无凭据 `git_url`、默认分支和工程知识协议状态，不保存 clone 路径或 token。
- Platform Task 是协作对象；Runner execution 是一次本地执行。两者使用不同 ID 和状态机，通过显式绑定关联。
- Platform 只能通过版本化 allowlist RPC 请求操作。Runner 在本机解析 Repository、Task 和 session，Platform 不传入可执行 argv 或任意路径。
- Platform 可以保存 branch、commit、session 名与 execution 状态；不保存 `.alignyard/` 正文、摘要或 Git diff，也不主动读取源码树或未提交文件。
- 终端先由 Platform 校验 execution actor，再由 Runner 校验本地 Task/session 绑定。
- Runner 选择对同一 Author execution 保持粘性；恢复或重试不静默迁移到另一设备。

# 影响

- Platform 数据库泄露不会直接得到 Git、gh/glab 或 Agent 凭据。
- 每个用户需安装并保持 Runner 在线，并自行配置所需 CLI。
- WebSocket 断开不终止 tmux；Runner 重连后可基于持久化 execution binding 恢复。
- Task 页面需要阅读文档时，只能经请求者自己的 Runner 临时解析其 worktree 并返回浏览器，Platform 不落库或缓存；`.alignyard/` 文档不得包含真实用户、已登记 Repository/Task、设备 token 或部署实例秘密。
- Platform SQLite 备份与 Runner 本地数据备份是两套责任，前者不能恢复用户的 worktree。

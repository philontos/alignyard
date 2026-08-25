---
id: adr.shared.node-local-ownership
title: "节点本地归属"
kind: adr
scope: shared
owners: []
relations:
  - doc.shared.architecture
  - doc.server.overview
  - doc.server.cli-configuration
---

# 背景

README 明确把 Switchyard 描述为本地优先、无中心服务器的节点网络，并说明每台机器是自身 Repository、数据库、worktree、tmux session 与 Agent 的唯一真源。`server/core/schema.ts`、`server/task/cli.ts` 和 `server/http/routes.ts` 进一步把这项约束写进数据模型和跨节点接口：平台共享行不保存 clone 与凭据，远端 Repository/Task 操作必须交给目标节点执行。

如果控制节点复制远端路径、凭据或 Task 状态并在本地代办，节点离线、数据漂移和权限泄漏会让同一资源出现多个互相矛盾的真源；远端没有安装 Switchyard 时走兼容捷径也会破坏相同边界。

# 决策

每个节点永久拥有并执行位于该节点的 Repository mirror、凭据、runtime Task、worktree、tmux session、Agent、Provider 与文件操作。控制节点只保存连接所需的节点元数据，并通过 SSH 调用目标节点已安装的准确 `tdsp` 命令；读取 fleet 状态时按需聚合各节点的版本化 JSON，而不是复制完整运行记录。

Alignyard 的 Platform Repository、Platform Task 和 artifact 可以作为协作目录存在，但平台 Repository 行保持 credential-free。创建或初始化 Task 时，服务必须先找到本机 owner-local Repository，再复用相同的 `repo/task/session` 服务建立 runtime。Repository ID、Task ID 和 Provider ID 始终按目标节点解释，不能用控制节点路径替代。

Tailscale 提供私有身份、发现和可达性，HTTPS 支持页面、探测和首次双向连接；实际远端 Repository、Task、终端和文件操作仍通过 SSH 在目标节点完成。目标节点缺少 Switchyard、离线或协议版本不兼容时，系统如实报告不可用，不回退到控制节点执行。

# 影响

- Repository token 与 Provider key 不跨节点复制，owner-local 路径和底层错误在跨节点 DTO 中被移除。
- 每台机器都必须安装并维护可调用的 `tdsp`；远端功能受目标节点 capabilities 与版本约束。
- fleet 页面是按需聚合视图。节点离线时状态为未知或不可达，不能依靠控制节点缓存宣称其 Task 仍然真实在线。
- 创建、恢复、停止、清理、删除、读取 transcript、代码检查和终端 attach 都必须路由到拥有节点；测试应覆盖本地与远端的对称语义和安全投影。
- 平台协作状态与 runtime 状态是不同对象。Platform Task 可链接本地 runtime Task，但不能取得其 worktree、tmux 或凭据所有权。
- 这种边界减少中心化同步和凭据托管，但要求每个节点独立备份自身数据，并在网络或 SSH 不可用时接受功能降级。

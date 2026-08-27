---
id: doc.server.overview
title: "后端服务概览"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.architecture
  - doc.server.http-api
  - doc.server.cli-configuration
  - doc.server.runner-protocol
  - doc.server.knowledge-protocol
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
---

# 概述

后端由一个 Platform 服务和一个用户本地 Runner 进程组成。`server/platform/main.ts` 是云端唯一入口；`server/runner/main.ts` 是本地唯一入口。两者共享少量类型与执行内核，但不存在可切换的 local execution mode。

## 启动与装配

Platform 启动顺序：

1. `core/db.ts` 打开 SQLite、启用 WAL 并幂等升级 schema。
2. `platform/app.ts` 装配健康检查、静态 Web、认证、Runner 路由和 Platform 路由。
3. `platform/main.ts` 创建 HTTP server，并由 `http/platform-ws.ts` 接管 `/runner` 与 `/pty?execution=...` upgrade。

Runner 启动顺序：

1. `runner/main.ts` 进入 `runner/cli.ts`。
2. `runner/client.ts` 读取权限受限的设备配置并建立出站 WebSocket。
3. 完成 `runner.hello` 后，`runner/operations.ts` 才处理 allowlist RPC。
4. Repository、Task、tmux 与 forge 操作委托给执行内核。

## 模块职责

| 目录或文件 | 职责 |
|---|---|
| `auth/` | Google identity、Platform session 与 service token 认证 |
| `platform/catalog.ts` | Platform Repository/Task/Review/execution 持久化规则 |
| `platform/runner-workflow.ts` | Author、Review、PR/MR、merge 的跨 Runner 状态机 |
| `platform/prompts.ts` | Repository Init、知识设计 Author 与 Reviewer Prompt 组合 |
| `runner/registry.ts` | pairing、设备 token 与归属查询 |
| `runner/gateway.ts` | Runner 在线状态、RPC correlation/timeout、终端通道 |
| `runner/operations.ts` | allowlist RPC 到本机执行内核的适配与幂等 binding |
| `repo/` | mirror、fetch、worktree 和 Runner-local Repository catalog |
| `task/` | runtime Task、引用 worktree、manifest 与 lifecycle |
| `session/` | Agent 参数、tmux、PTY 和输入安全处理 |
| `protocol/` | `.alignyard/` schema、校验、生成与 worktree 索引 |
| `http/` | Express/WS 边界适配 |

## 关键不变量

- Platform Repository 不含 token、mirror 路径或 worktree 路径。
- 只有兼容 hello 的连接计为在线；数据面消息在 hello 前被忽略。
- 一个当前 Task execution 使用一个稳定 execution ID；重试不创建第二个 worktree。
- Author execution 与 Reviewer execution 分开记录；Review 结束后恢复原 Author 指针。
- 提交 Review 时由 Runner 执行 `ay validate`、检查 clean worktree 与新提交，并 push 工作分支。
- Review approve 后为每个 editable Repository 固化 `design_commit`；普通 Task 到此成为可开始实现的设计交付，不创建 PR/MR。
- Task 只有远端 PR/MR 为 `merged` 后才能完成。
- 所有 Task/Repository 变更都校验 owner 或当前 reviewer；设备只能由其用户撤销。
- `runner/operations.ts` 只接受固定 RPC 和参数边界，不向 Agent 注入 Platform 凭据。

## 结构化拆分方向

当前已删除旧产品的大型路由和 UI，Platform/Runner 依赖图不再包含 Host、Network、Provider 或 Codeview。仍需渐进拆分的高密度文件：

- `platform/catalog.ts`：按 Repository、Task、Review/execution 查询模块拆分，但保留共享事务边界。
- `platform/runner-workflow.ts`：按 Author、Review、change request 子流程拆分，状态转换集中定义。
- `web/js/platform.js`：按 Repository 与 Task workspace 交互闭环拆分。
- `core/schema.ts`：当前同时初始化 Platform 与 Runner 表。两边数据目录独立，行为正确，但后续应拆成 Platform schema、Runner schema 与显式共享迁移，不能通过删列破坏已有数据库。
- `platform/forge.ts`：实际由 Runner 调用；待执行内核包边界稳定后迁到 Runner/forge 适配目录。

拆分必须降低职责数量和依赖扇出；不要仅为减少行数增加转发层。

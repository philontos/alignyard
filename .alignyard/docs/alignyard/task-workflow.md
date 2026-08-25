---
id: doc.alignyard.task-workflow
title: "Task 协作流程与平台接口"
kind: doc
scope: alignyard
owners: []
relations:
  - doc.alignyard.overview
  - doc.alignyard.knowledge-protocol
  - doc.switchyard.node-task-protocol
  - doc.switchyard.http-realtime-api
---

# 概述

Alignyard 平台用 Repository catalog 和 Task 状态机编排本地 Agent 工作、工程知识同步、人工 Review 与 GitHub PR/GitLab MR。平台元数据在 sqlite 的 `platform_*` 表中；真实 clone、worktree、凭据和 Git/Forge 操作留在执行者节点。

## Repository 状态

Repository 协议状态为：

- `uninitialized`：默认分支没有完整 `.alignyard` 基线。
- `initializing`：已有未完成的 `repository_init` Task。
- `ready`：默认分支可读取 manifest 和全部固定基线文件。
- `invalid`：找到 manifest，但结构无效或缺少基线文件；错误原因保存在 `protocol_error`。

普通 `change` Task 只能把 `ready` Repository 设为 `editable`。Repository 可作为多个 Task 的 `editable` 或 `reference`，因此删除 Repository 时若仍被 Task 引用必须拒绝。

## Task 模型与状态机

Task 类型为 `change` 或 `repository_init`，状态只有 `draft`、`review`、`approved`：

- `draft → review`：提交人工 Review。
- `review → draft`：要求修改；Repository Init 会把 editable Repository 的 manifest 状态重置为 `waiting`，必须重新 sync。
- `review → approved`：审核通过。Repository Init 通常在成功创建 PR/MR 后进入此状态。
- `approved → draft`：仅 Repository Init 且存在打开的 PR/MR 时允许，用于继续修订。

Task 可以关联多个 Repository，但至少一个是 `editable`；每个关联记录 base branch、固定 base/head commit、稳定 work branch、assignee、manifest 状态和最后上报时间。默认工作分支为 `change/<task-key-lowercase>/<assignee-slug>`。

## Repository Init 流程

1. `POST /api/platform/repositories/:id/initialize` 幂等创建或返回初始化 Task，并把 Repository 标为 `initializing`。
2. `POST /api/platform/tasks/:key/run` 在本机可用 mirror 上创建稳定分支 worktree，关联一个自动化 Switchyard runtime task，并注入平台地址、Task key 和 Repository id。
3. Agent 只修改当前 worktree 的 `.alignyard/`，运行 `ay validate`，提交后运行 `ay sync`。平台校验中文、hash、scope、路径和 shared overview，记录 artifact 与 head commit。
4. `POST /api/platform/tasks/:key/review` 要求 worktree 干净、HEAD 不等于 base commit、HEAD 等于最近 sync 的 head commit；通过后停止 runtime session并进入 `review`。
5. `POST /api/platform/tasks/:key/pull-request` 是人工确认边界。平台再次核实本地状态，push 工作分支，使用已认证的 `gh` 或 `glab` 创建 PR/MR，记录编号和 URL，再进入 `approved`。
6. `POST /api/platform/tasks/:key/merge` 是第二个人工确认边界。平台通过 Forge CLI 合并，刷新默认分支协议状态；只有状态变为 `ready` 才完成，并尽力删除远端工作分支和清理 runtime worktree。

Agent 自动执行权限只覆盖本地 Task worktree 中的检查、文档、提交与 sync，不授权 push、创建 PR/MR、merge 或直接修改默认分支。

## 平台接口

| 接口 | 作用 |
|---|---|
| `GET/POST /api/platform/repositories` | 列出或登记共享 Repository locator |
| `DELETE /api/platform/repositories/:id` | 先删除 owner-local clone，再删除无 Task 引用的平台元数据 |
| `POST /api/platform/repositories/:id/initialize` | 创建/复用 Repository Init Task |
| `POST /api/platform/repositories/:id/refresh` | 从本机 mirror 的默认分支刷新协议状态 |
| `GET/POST /api/platform/tasks` | 列出或创建 Task |
| `GET/PATCH/DELETE /api/platform/tasks/:key` | 读取、改变状态或安全删除 Task |
| `POST /api/platform/tasks/:key/run` | 启动或复用 Repository Init runtime |
| `POST /api/platform/tasks/:key/review` | 校验提交/sync 一致性并提交 Review |
| `POST /api/platform/tasks/:key/pull-request` | 人工确认后 push 并创建 PR/MR |
| `POST /api/platform/tasks/:key/merge` | 人工确认后合并、刷新和清理 |
| `POST /api/platform/tasks/:key/sync` | 接收 `ay sync` 的有界知识快照 |
| `GET /api/platform/artifacts` | 列出同步后的工程知识 artifact 摘要 |

输入校验错误通常为 `400`，不存在为 `404`，状态/归属冲突为 `409`，本地启动失败为 `500`，Forge 外部操作失败为 `502`。UI 和自动化应根据状态码与 `{ error }` 显示可行动错误，不能假定所有失败都可直接重试。

## Forge 与幂等保护

GitHub/GitLab 通过 Git URL 初判，self-hosted 或不明确 locator 使用已认证的本机 `gh`/`glab` 进一步识别。创建和合并属于无法与 sqlite 同事务提交的外部副作用：工作流按 Task 合并并发点击，并在本地命令报错后查询远端是否其实已成功，避免重复 PR/MR 或重复 merge。

删除未完成 Task 时，如果存在打开的 PR/MR，必须先用对应 Forge CLI 关闭并清理 source branch；无法确定 Repository、分支、编号或本机工作目录时拒绝删除。之后才清理 runtime task/worktree 和平台记录。已完成 Repository Init 被删除时保留 Repository 的 `ready` 状态；未完成初始化被删除时 Repository 回到 `uninitialized`。

## Review 与知识一致性

Repository Init 进入 Review 的最低门槛是：editable 关联的 `manifest_status='valid'`、artifact 中包含 `.alignyard/docs/shared/overview.md`、worktree 无未提交变更、存在相对 base 的新提交、最新 HEAD 已经 sync。`ay validate` 只证明本地结构，`ay sync` 只证明平台接受快照；人工 Review 仍需检查内容是否准确、小而完整，并确认 overview 能导航到所有长期主题。

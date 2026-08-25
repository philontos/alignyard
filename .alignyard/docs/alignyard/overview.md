---
id: doc.alignyard.overview
title: "Alignyard 概览"
kind: doc
scope: alignyard
owners: []
relations:
  - doc.shared.overview
  - doc.shared.development-workflow
  - doc.alignyard.knowledge-protocol
  - doc.alignyard.task-workflow
  - doc.switchyard.node-task-protocol
---

# 概述

Alignyard 是本仓库中的共享工程协作面。它把 Repository、Task 和随代码版本管理的工程知识连接起来，并复用 Switchyard 的 owner-local worktree、Agent 和终端能力执行具体工作。`web/platform.html` 是当前 `/` 页面，`server/platform/` 保存平台 catalog、同步、Forge 和工作流逻辑，`server/protocol/` 定义仓库内 `.alignyard` 与 `ay` CLI。

## 核心实体

- Repository：共享 catalog 只保存 name、Git locator、default branch、初始化状态和创建信息，不保存 clone 路径或凭据。
- Task：一个需求或变更的长期协作对象，key 形如 `AY-003`；与本地 runtime task 分离，状态为 `draft`、`review` 或 `approved`。
- Task Repository：Task 可关联多个 Repository；`editable` 可产生提交，`reference` 只提供固定上下文。普通变更至少有一个 `editable` Repository。
- Artifact：`ay sync` 上报的 Doc、Spec、ADR 快照，包含 scope、路径、关系、内容 hash、base/head commit 和 change kind。
- Runtime Task：平台 Task 可关联一个本机 Switchyard task，用于 worktree、tmux 和 Agent；平台不把它当作共享 Repository 真源。

## 主要数据流

1. 在 Alignyard 登记 Git Repository locator；本机还必须单独拥有可用 mirror 才能执行工作流。
2. 默认分支缺少 `.alignyard` 基线时，Repository 进入 `uninitialized`，通过一条 `repository_init` Task 建立知识。
3. 平台在本机创建 `change/<task-key>/<member>` worktree 和自动化 Agent；Agent只在该 worktree 修改、验证、提交并运行 `ay sync`。
4. 平台保存经过校验的 artifact 快照与 head commit。进入 Review 前要求 worktree 干净、确有新提交且最新提交已同步。
5. 人工确认后，平台使用本机 `git` 和已认证的 `gh`/`glab` 创建 PR/MR；再次确认后合并、刷新默认分支协议状态并清理 worktree。

普通 `change` Task 也使用 Repository 模式和稳定工作分支，但只有 `protocol_state='ready'` 的 Repository 可以作为 editable；未初始化 Repository 只能作为 reference，或先完成 Repository Init。

## 边界与依赖方向

Alignyard 平台表与旧 `repos`/`tasks` 表共处一个 sqlite，但语义不同：平台表是共享协作记录，runtime 表是当前节点的执行状态。`server/platform/workflow.ts` 可以调用 Switchyard 的 task 创建/停止/清理能力，反向依赖不成立；`.alignyard` 文件始终属于目标 Git Repository，而不是平台数据库的替代品。

`ay sync` 只发送有界的 manifest 和文档快照，不发送整个 checkout、任意文件或 secret。Git clone、token、worktree、Agent credential 与 Forge 登录保留在执行者机器。平台通过本机 mirror 读取默认分支的固定基线文件，以确认 Repository 初始化状态。

## Web 工作区

`web/js/platform.js` 管理 Repository/Task 列表、状态、Review、PR/MR 和合并操作；`web/js/platform-agent.js` 复用 `/pty` 在 Task drawer 内嵌 runtime Agent；代码预览复用 `web/js/features/codeview.js`。UI 发起的外部副作用都对应显式确认步骤，不能因为 Agent 已完成本地提交就自动 push、建 PR/MR 或 merge。

## 相关知识

`.alignyard` 文件结构、文档语义、校验和同步见 `doc.alignyard.knowledge-protocol`。Repository/Task 状态、平台 API 与人工确认边界见 `doc.alignyard.task-workflow`。owner-local runtime 不变量见 `doc.switchyard.node-task-protocol`。

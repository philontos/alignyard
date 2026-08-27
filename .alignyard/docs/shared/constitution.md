---
id: doc.shared.constitution
title: "工程约束"
kind: doc
scope: shared
relations:
  - doc.shared.overview
  - doc.shared.architecture
  - doc.server.knowledge-protocol
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
  - adr.shared.knowledge-first-product-boundary
sources: []
governing: []
---

# 概述

这份文档是 Alignyard Repository 的固定工程约束入口。普通 Task、Repository Init、人工 Review 和后续实现都必须先遵守这里的产品意图、系统边界与确认规则；更具体的事实和决策通过 relations 导航到对应 Docs 与 ADRs。

## 真源边界

- `.alignyard/` 是核心工程意图、架构边界、重要约束和变更契约的真源；它可以持续演进，但任何改变都必须显式 Review。
- 代码、类型、测试与运行行为是具体实现事实的真源。可以从这些载体直接准确获得的函数调用、局部算法和普通字段传递，不在 `.alignyard/` 重复维护。
- 判断一条信息是否应进入 `.alignyard/`：如果未来 Agent 不知道它，可能写出局部正确但违背整体设计意图的实现，就应记录；否则留在代码或测试中。
- Docs、Specs 和 ADRs 必须精简、明确、可执行。一个文件只承担一个稳定主题或关键决策，不保存会议过程、实现日志或可由源码推导的细枝末节。

## 产品意图

- Alignyard 的核心产品是核心工程意图与架构约束的编撰、关联、阅读、人工 Review 与协作流转，不是通用 AI 编码平台，也不追求记录整个工程。
- 普通 Task 默认先形成最小充分的设计包：按变化性质新增或更新 Spec、ADR、Plan、Docs，再由人确认设计基线。编码是可接入但非必选的后续能力。
- 默认分支的 Docs 描述当前已发布事实；Task 分支正常路径中的 Docs 描述待发布目标状态。不得维护 temp Docs 或另一套知识真源。
- 原始飞书文档等外部来源只用于追溯；实现和验收以人工确认后的 Spec、ADRs、Plan 与适用 Docs 为准。

## 架构边界

- Platform 只保存身份、Repository 地址与名称、Task/Review 状态、工作分支和必要 commit 等协作元数据；不保存工程知识、摘要或 Git diff，不 clone 用户 Repository，也不保存 Git、forge 或 Agent 凭据。
- Runner 永久拥有本地 mirror、worktree、tmux、Agent 登录和 Git/gh/glab 凭据，只执行版本化 RPC allowlist，不开放任意 shell 或 argv 接口。
- Browser 只连接 Platform；本机 Runner 使用出站 WebSocket。Browser 不接收设备 token、本机路径或 Runner-local Task ID。
- `.alignyard/` 只保存适合提交到 Repository 的通用工程知识，不写入运行实例用户、Task、token、本机绝对路径、云项目或秘密值。
- 一个 Task 的长期模型允许多个 Repository 分别拥有分支与设计基线；在跨仓库 Review 和失败补偿完成前，Runner workflow 继续限制单一 editable Repository。

## 人工确认

当缺少信息可能改变产品意图、公共接口、架构边界、安全和隐私、兼容性、跨 Repository 契约或修改范围时，Agent 必须直接在当前会话向用户确认，不能自行选择一种假设继续。确认后的结论写入最终 Spec、ADR、Plan 或 Docs，不额外创建独立 Decision Request 实体。

人工 Review 决定设计是否被接受。Reviewer Agent 只能提供证据、解释或按人类指令修改，不能替人批准。普通 Task Review 通过只表示设计已确认并可开始实现；Repository Init 必须合入默认分支后才完成。

文档作者、修改者和审核人使用 Git commit、Git blame、PR/MR Review 与 Alignyard Task Review 追溯。前期不为此增加独立 owner、责任人或原则作者模型；如果修改 governing 文档，提交人必须在 Review 中明确说明改变了什么核心意图，由指定 reviewer 确认。

## 机器检查

- `ay validate` 是 `.alignyard/` 目录、manifest、模板、frontmatter、必需章节和引用完整性的结构权威，但不能证明内容事实正确。
- 用户与 Agent 判断内容具备审核条件后才提交 Review；Platform 不维护“知识已完成”状态。
- 提交 Review 时，Runner 必须重新执行 `ay validate`，并保证 worktree clean、有新提交且工作分支成功 push。
- 代码修改必须通过 TypeScript 检查、相关测试、`ay validate` 与 `git diff --check`；部署和 Runner 脚本变更还需执行对应 shell 或 Compose 检查。

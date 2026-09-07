---
id: spec.server.plan-task-ledger
title: "细粒度 Plan 实施任务账本"
kind: spec
scope: server
relations: []
sources: []
governing:
  - doc.shared.constitution
  - doc.server.knowledge-protocol
  - adr.shared.knowledge-first-product-boundary
---

# 背景

Alignyard protocol v2 已有 Plan，但 Plan 仍是可选的粗粒度技术方案，默认模板只有笼统的“实施步骤”。`ay validate` 只检查 Plan 的章节与 Constitution 关联，无法识别缺失的 Phase、不可追踪的任务编号、非 checkbox 工作项或缺少独立验证依据的任务。Agent 因而可能从较粗的 Spec/Plan 直接进入编码，跨 session 时也没有可靠的实施账本。

# 目标

- 在不增加新文档 kind 的前提下，把 Plan 扩展为中大型改动的技术设计与细粒度实施账本。
- 新 Plan 默认按 Phase 生成带稳定编号的 checkbox 任务；每项记录依赖、产出、完成标准、验证命令和验证结果。
- `ay validate` 对新版协议校验 Phase、任务编号唯一性、checkbox、任务所属 Phase、必要字段和 governing 关联。
- 实现期间持续更新 checkbox 与验证结果；未完成项保留阻塞原因，成为跨 session 的交接入口。
- 保持小修、单文件修改、typo 和简单配置无需创建 Plan，也不让 Plan 重复声明 Spec、ADR 或 Constitution 中的业务契约。
- 保持 protocol v1/v2 Repository 的既有 Plan 可由新版 `ay` 校验，只有显式升级到新版协议后才启用任务账本约束。

# 非目标

- 不恢复 OpenSpec 或任何第二套架构、业务契约真源。
- 不新增独立 `task` 文档 kind，也不在首轮增加 `ay status`。
- 不让结构校验器判断任务描述是否在语义上足够细；这仍由 Agent 和人工 Review 负责。
- 不自动改写 Repository 中已有 Plan 正文；协议升级需要的正文调整必须作为显式 Git diff Review。

# 设计

将工程知识协议提升到 v3、Alignyard 管理框架提升到 v4。v3 延续 v2 的 `doc/spec/adr/plan`、固定 overview/constitution 入口和 frontmatter 契约，仅新增 Plan 正文结构约束。v1/v2 仍按原有章节和关联规则校验，避免安装新版 CLI 就让未升级 Repository 失效。

v3 Plan 将“实施步骤”替换为“实施任务”。该章节至少包含一个 `## P<n> <阶段标题>`，每个 Phase 至少包含一个 `- [ ] P<n>.<m> <任务标题>` 或已完成的 `- [x] ...`。任务编号在单份 Plan 内唯一，且前缀必须与所属 Phase 一致。每个任务块必须包含“依赖、产出、完成标准、验证、验证结果”；完成项的验证结果不能仍是“待执行”。未完成但受阻的任务使用可选“阻塞”字段保存原因。

Plan 的 `governing` 必须包含 `doc.shared.constitution`，并至少再关联一份对应的 Doc、Spec 或 ADR。Plan 只引用这些权威约束并描述实现映射，不复制业务契约。ADR 仍仅在存在长期选择及替代方案时需要，不能为了通过结构校验制造 ADR。

默认模板提供 P0 契约与基础结构、P1 核心实现两个 Phase 的可编辑任务骨架。占位任务与字段使用明确的 `TODO`，校验器拒绝未替换的占位内容，确保新建 Plan 不能以空骨架冒充可执行计划。Skill 负责判断 Plan 门槛和实施期维护规则：中大型、跨模块、公共契约、状态流、数据结构或多 Phase 改动在编码前必须有 Plan；小改动继续允许跳过。

Runner 制品版本随 CLI/protocol 能力提升到 `0.1.12`。`ay update` 把 manifest 升级到 protocol v3/framework v4 并替换受管理模板和 Skill，但继续保留所有已有知识正文；若 Repository 有旧 Plan，Agent 必须在框架更新 Task 中显式迁移并 Review。

# 验收标准

- `ay new plan ...` 默认生成至少两个 Phase 和带编号的 checkbox 任务骨架。
- protocol v3 拒绝缺少 Phase、缺少 checkbox、重复编号、编号与 Phase 不匹配、缺少必要字段、残留 `TODO` 和完成项无验证结果的 Plan。
- protocol v3 Plan 必须关联 Constitution 及至少一份对应的 Doc、Spec 或 ADR；悬空引用继续被拒绝。
- protocol v1/v2 的既有文档与旧 Plan 仍保持兼容；`ay update` 后才启用 v3 结构。
- 管理模板、内嵌生成源、Skill、协议文档和版本说明保持一致。
- `npm test`、TypeScript 检查、`npm run ay -- validate .` 与 `git diff --check` 全部通过。

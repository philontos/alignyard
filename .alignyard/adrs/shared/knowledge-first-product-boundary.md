---
id: adr.shared.knowledge-first-product-boundary
title: "知识设计闭环优先于编码执行"
kind: adr
scope: shared
relations:
  - doc.shared.constitution
  - doc.shared.overview
  - doc.shared.architecture
  - doc.server.knowledge-protocol
  - doc.web.overview
  - spec.shared.knowledge-first-task
  - adr.shared.platform-runner-separation
sources: []
governing:
  - doc.shared.constitution
---

# 背景

Alignyard 的核心价值不是记录整个工程，而是把 AI 不能随意重新决定的产品意图、架构边界、长期取舍和变更契约形成可阅读、可讨论、可审核、随 Repository 版本化的真源。AI 可以显著加快实现，但缺少这些约束时也会更快地产生漂移、错误假设与跨模块破坏。

现有普通 Task 把“完成实现、测试和知识更新”作为默认目标，容易让工程知识成为编码后的补充材料，也使平台与通用 Agent 编码工具竞争。团队实际需要的是先把设计讨论闭环，再自由选择 Codex、Claude、IDE 或其他环境实现。

# 决策

- Alignyard 默认负责从原始需求到知识设计包的闭环：Spec、必要 ADR、可选技术方案、目标 Docs、人工 Review 和版本化设计基线。
- `.alignyard/` 只保存会影响 Agent 决策方向的核心工程意图与架构约束；代码、类型、测试和运行行为继续作为具体实现事实的真源，不把可直接从源码获得的细节复制进长期文档。
- Specs 与 ADRs 以最小充分为标准，一个文件只表达一个变化契约或长期取舍。小修正、纯文档整理或已有 Spec 已完整覆盖的 Task 不强制新建 Spec。
- 编码是可接入的后续能力，不是普通 Task 的默认交付物，也不是平台第一阶段的强制流程。
- Agent 遇到可能改变产品意图、公共接口、架构边界、兼容性或修改范围的关键不确定性时，必须在当前会话中询问人类，不能自行推断；确认结果直接写入最终知识，不新增独立决策实体。
- Spec 是需求权威；飞书等原始来源只用于追溯。技术方案必须明确引用适用的 Constitution、Docs、Specs、ADRs，并写明修改范围与保持不变的内容。
- 默认分支 Docs 表示当前已发布事实，Task 分支正常路径下的 Docs 表示目标状态；不维护临时 Docs 副本。
- Platform 只保存用户、Repository 地址与名称、Task、Review、工作分支和必要 commit 等协作元数据，不保存工程知识、摘要或 Git diff。完整设计包只存在于 Git Repository 和用户 worktree，读取与修改权限由 GitHub/GitLab 决定。
- 人工 Review 通过产生 Repository 级 `design_commit`，普通 Task 随后停在可开始实现状态。外部实现可以继续使用同一远端分支。
- Repository Init 作为建立工程知识基线的特殊流程，仍需通过 PR/MR 合入默认分支后才完成。
- 跨 Repository Task 的长期模型是一个 Task 聚合多个 Repository 各自的分支和设计基线；在失败补偿与 Review 语义完成前继续限制单一 editable Repository 执行。
- 作者与审核轨迹复用 Git commit、PR/MR 和 Alignyard Review；前期不增加独立原则作者或 owner 模型。

# 影响

- 产品 UI、Prompt、Review 和状态说明以文档编撰与设计确认作为中心，终端与编码能力退居辅助位置。
- 普通 Task 的 approved 不再意味着马上创建 PR/MR，而表示设计已经由人确认并可交给实现者。
- 协议增加 constitution 固定入口和 plan kind；`ay validate` 在本地校验完整来源及约束关系。用户提交 Review 时 Runner 重新校验、检查提交并 push，Platform 只记录流转结果。
- Agent 可以通过当前终端会话持续向用户提问；问题本身不形成平台对象，长期价值只由最终 Spec、ADR、Plan 或 Docs 承载。
- 外部实现脱离 Platform 后，远端工作分支与 `design_commit` 仍提供稳定交接点；实现后的合并检查留给后续 GitLab Runner/GitHub Actions 能力。
- 设计包的质量成为主要产品质量指标，需要后续持续优化模板、知识路由、worktree 内文档阅读、关系导航和 Agent 辅助 Review 体验。

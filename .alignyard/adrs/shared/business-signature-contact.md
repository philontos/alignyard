---
id: adr.shared.business-signature-contact
title: "业务约束与决策使用可选署名作为沟通入口"
kind: adr
scope: shared
relations:
  - adr.shared.knowledge-first-product-boundary
  - doc.server.business-constraints-and-decisions
  - spec.server.business-constraint-attribution
sources: []
governing: []
author: Phil
---

# 背景

后续业务需求可能与既有规则或选择冲突，Review 除了指出差异，还需要提供一个可直接联系的人。仅用 Git/MR 可以还原编辑过程，但批量迁移和代写时无法直接确定应向谁了解业务背景。

# 决策

业务关键约束继续用 Doc，决策日志继续用 ADR，二者增加可选 author 署名，含义仅为记录人和沟通入口。创建时自动填入目标仓库 Git user.name，允许显式覆盖、手动编辑或留空，不增加审批人、权限或负责人模型。

这项选择替代 adr.shared.knowledge-first-product-boundary 中仅依赖 Git/MR 追踪而不增加显式署名的部分；其余知识真源、人工 Review 和 Platform/Runner 边界不变。Git/MR 仍承担修改及批准的历史证据。

选择可编辑的一个姓名，而不引入多角色身份模型，是为了降低维护成本。代价是名字可能缺失或过时，且不是经过认证的决策人；Review 应如实显示署名，不能从名字推定批准。

# 影响

需求开始先读相关业务约束和 ADR；Review 对照原规则说明冲突、影响和署名，人确认后同步更新当前约束，必要时新增并关联取代旧选择的 ADR。历史内容不批量推断署名，缺失不阻止流程。仓库 rules 与其他文档模块保持既有职责。

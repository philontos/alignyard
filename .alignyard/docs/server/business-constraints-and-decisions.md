---
id: doc.server.business-constraints-and-decisions
title: "业务关键约束与决策日志使用闭环"
kind: doc
scope: server
relations:
  - doc.server.knowledge-protocol
  - spec.server.business-constraint-attribution
  - adr.shared.business-signature-contact
sources: []
governing: []
---

# 概述

当前重点是业务关键约束和决策日志。业务关键约束用 Doc 写“当前必须遵守什么、在哪些场景适用”；决策日志用 ADR 写“为什么选择这个方案、接受什么取舍”。编码规范与 Agent 工作方式由 AGENTS.md/Harness 承担。其他 Doc、Spec、Plan、Constitution 保留现有用途，本机制不扩展它们的职责。

# 创建和署名

```sh
ay new doc subscription-entitlements --scope billing --constraint --title '订阅权益约束'
ay new adr retain-earned-entitlements --scope billing --title '到期保留已获得权益'
```

示例假定 repository.yaml 已声明 billing scope。业务约束 Doc 至少说明规则与适用范围，例如“订阅到期只停止新增权益，已获得的永久权益继续保留”。ADR 说明为何选择保留以及回收方案的代价，通过 relations 关联该 Doc。

两条命令创建时自动读取目标仓库 Git user.name 填入 frontmatter 的 `author`；可以加 `--author '示例联系人'` 指定，或直接编辑文件修改/删除。显式 `--author ''` 可以创建空署名。普通 `ay new doc` 不自动署名；ADR 默认署名。不新增文档种类或额外身份模型，`--constraint` 仅是 Doc 的创建便捷选项。

署名表示记录人和沟通入口，不证明该人审批过内容，也不赋予永久审批权。找不到 Git 身份就留空，不阻止创建、校验或 Review。编辑和更新不覆盖原署名；历史文档按需要人工补充，不从批量迁移提交推定决策人。Git/MR/Review 继续记录修改与确认。

# 需求到 Review

- 开始需求时，按业务主题、scope、relations、governing 找到适用 Doc 与 ADR；Spec 仍描述本次要改变什么。
- Review 使用 Task 固定 base commit 的原文和当前 diff；同时检查本次被修改或删除的规则，不能拿改后的规则证明没有冲突，也不能漏掉未写进 governing 的相关约束。
- 对每个冲突或不确定项，写清原文位置、本次变化、具体影响和署名。未署名只提示缺少联系信息；没有找到相关记录不等于已经证明符合。
- 由人确认业务取舍。署名不是审批门禁，结构校验也不能证明业务一致。

| 原约束/决策 | 本次变化 | 冲突或不确定性 | 署名 | 需要确认 |
| --- | --- | --- | --- | --- |
| Doc：到期保留永久权益 | 到期统一清零 | 会回收已获得权益 | 文档 author；缺失写未署名 | 是否改变既有权益规则及适用对象 |

# 确认调整后的闭环

同一变化中更新 Doc，使其表达当前有效规则。有实质取舍变化时新增 ADR，写清新理由、后果和替代旧决策的部分；通过 relations 双向关联，并在旧 ADR 正文注明替代关系，保留旧理由。仅文字修正不新增 ADR。

提交 Review 前核对 Doc 与 ADR 的结论一致，说明仍未解决的问题，运行 ay validate 并沿用已有 Review/合并流程。后续需求从更新后的 Doc 获取当前约束，沿 ADR 关联追溯当前决策和历史原因。

# 发布与采用

本能力随 framework v5 和 Runner 0.1.13 发布，协议仍为 v3。Alignyard 的生成 Skill/模板与 CLI 随 Runner 分发，Review prompt 随 Platform 部署。只更新云端不更新本机工具，或只更新本机工具不更新业务仓库，都不会完成整个闭环。

发布者合入并验证 Alignyard → 构建与发布 Runner 制品并部署 Platform → 用户安装新版 Runner/ay → 每个业务仓库在工作分支运行 ay update → 校验、Review 并合入 → 后续任务读取新版 Skill。完整命令与检查见 docs/deployment.md 的“业务约束与决策日志发布”。

ay update 更新管理文件，不自动给旧知识补署名或改变业务结论。protocol v1/v2 升级还需处理既有 v3 Plan 兼容要求；这不是本次署名增加的门禁。未更新的活跃工作分支仍使用旧模板/Skill，应合入框架升级后重新读取规则；现有 Review 会话需重新加载新版提示或明确读取新版 Skill。

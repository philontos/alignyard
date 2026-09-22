---
id: spec.server.business-constraint-attribution
title: "业务关键约束与决策日志署名"
kind: spec
scope: server
relations: []
sources: []
governing:
  - doc.shared.constitution
  - doc.server.knowledge-protocol
---

# 背景

后续需求和既有业务规则冲突时，需要看清原约束、原取舍和可以联系的人。Git 保留编辑历史，但提交人不一定是业务决策的确认人。

# 目标

- 业务关键约束由 Doc 记录当前规则和适用范围；决策日志由 ADR 记录选择、理由和后果。
- 两者提供单一可编辑署名 `author`，只表示记录人和沟通入口，缺失不阻止工作。
- 需求、Review、调整和后续读取形成闭环，明确指出不一致及联系对象。

# 非目标

- 不新增文档类型、审批身份、责任模型或专门页面，不调整其他现有模块。
- 不把编码规范、Agent 行为等仓库 rules 纳入业务约束建设；它们由 AGENTS.md/Harness 承担。
- 不批量回填旧文档，也不把 Git 身份视为决策审批证据。

# 设计

`ay new doc <slug> --scope <scope> --constraint` 仍创建普通 Doc，提示填写业务规则和适用范围，并自动署名；ADR 默认自动署名。普通 Doc、Spec、Plan 的创建保持原样。`--author` 可显式指定署名；否则读取目标仓库有效的 Git user.name，缺失或不可读取时留空，不修改 Git 配置。只在创建时填入，后续编辑和框架更新不覆盖已有署名。Platform 不增加身份注入链路；用户可以通过命令或文件修正姓名。

新增 `author` 是可选字符串，不引入业务状态、权限或确认人。旧文档没有署名仍可校验和 Review；Git/MR 继续追踪编辑和批准。业务规则与 ADR 通过现有 relations 关联；有多个不同联系人的内容宜拆为各自独立的业务主题。

需求开始时按 scope、主题、relations 和 governing 查找相关业务约束与 ADR。Review 对照固定 base commit 中的原规则及当前 diff，给出原文位置、本次变化、具体冲突或未知信息和署名；漏写 governing 不等于没有约束，缺署名仅表明联系信息缺失。Agent 提供判断依据，人确认实质取舍。

确认调整后，在同一变化中将 Doc 更新为当前规则；有新的实质取舍时新增 ADR，说明它替代旧决策的哪一部分，并双向关联，保留旧决策理由。无需新增状态字段；旧 ADR 正文注明被哪份决策替代，后续读取沿关系找到当前结论。普通措辞修改不创建 ADR。

# 验收标准

- CLI 覆盖自动署名、显式指定、无身份、特殊字符、普通文档不受影响。
- 手动修改或删除署名后仍可校验，框架升级保留正文和署名；生成规则与 Review 提示包含上述闭环。
- 提升框架和 Runner 版本，提供发布、用户安装、业务仓库更新及生效检查路径；本任务不执行线上发布。

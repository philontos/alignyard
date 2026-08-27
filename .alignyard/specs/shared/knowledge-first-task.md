---
id: spec.shared.knowledge-first-task
title: "知识优先的 Task 设计闭环"
kind: spec
scope: shared
relations:
  - doc.shared.constitution
  - doc.shared.overview
  - doc.shared.architecture
  - doc.server.knowledge-protocol
  - doc.server.runner-protocol
  - doc.web.overview
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
  - adr.shared.knowledge-first-product-boundary
sources: []
governing:
  - doc.shared.constitution
  - adr.shared.knowledge-first-product-boundary
---

# 背景

AI-native 团队的主要协作成本逐渐从逐行编码转向需求澄清、系统边界、接口定义、技术取舍与结果验证。Alignyard 已能初始化 Docs、Specs、ADRs，也具备 Runner worktree、人工 Review 与 PR/MR 流程，但普通 change Task 的 Prompt 仍以实现和测试为默认目标，协议也缺少固定入口与可选的技术方案产物。

平台需要先闭环“原始需求转化为最小充分的权威设计、核心约束关联、可选技术方案与目标 Docs 编撰、人工审核、形成可交付分支”的过程。代码可以在同一工作分支上由 Alignyard 内 Agent 或任意外部工具继续完成，但不属于第一阶段的必选交付物。

# 目标

- 将普通 change Task 的默认产物改为可评审的知识设计包，而不是代码实现。
- 明确 `.alignyard/` 只保存会影响 AI 决策方向的核心工程意图、架构边界、重要约束和变化契约；具体实现细节仍以代码、类型与测试为准。
- 让 Agent 根据变化性质选择新增或更新 Spec、ADR、Plan、Docs，不强制每个 Task 新建主 Spec，也不为形式完整制造文档。
- 在 Repository 协议中加入固定的 overview/constitution 入口，以及可选的 `plan` 技术方案。
- 让技术方案显式引用原始需求来源和必须遵守的 Constitution、Docs、Specs、ADRs，并说明修改范围、保持不变的行为、实施步骤与验证方式。
- 继续在正常 `.alignyard/docs/` 路径起草目标状态 Docs；默认分支表示已发布事实，Task 分支表示待发布状态，不创建临时 Docs 副本。
- 使用本地完整校验、远端工作分支、commit 与 Review 流程审核设计包；Platform 只保存流转元数据，不保存工程知识、摘要或 diff。
- 人工 Review 通过后记录不可变 `design_commit`，把普通 Task 交还发起人并标记为可开始实现，不自动进入 PR/MR 阶段。
- 保持 Platform/Runner 边界：Runner 继续拥有 Git、worktree、Agent 和 forge 凭据；Platform 仅在用户主动阅读时中转其自己 Runner 临时解析的文档，不持久化响应。
- 数据模型允许未来一个 Task 为多个 editable Repository 分别保存 branch 与 `design_commit`；本版继续只执行一个 editable Repository。

# 非目标

- 不新增 Decision Request、`ay ask`、等待人工确认状态或对应 UI/API；Agent 在当前会话中直接询问用户，并把结论写入最终文档。
- 不负责代码生成、代码 Review 或实现完成后的文档校准。
- 不实现 GitLab Runner、GitHub Actions 或 PR/MR 合并前检查。
- 不在本版放开多个 editable Repository 的 Runner 执行、跨仓库 Review 或失败补偿。
- 不创建 `.alignyard/temp-docs/`、草稿副本目录或第二套文档 ID。
- 不把飞书等外部需求来源提升为高于 Spec 的权威依据。

# 设计

## 协议 v2

`repository.yaml` 使用 `version: 2`，保留 `preset: basic` 和 scopes，并增加固定入口：

```yaml
entrypoints:
  overview: doc.shared.overview
  constitution: doc.shared.constitution
```

`.alignyard/docs/shared/constitution.md` 仍是 `doc`，记录产品意图、架构边界、需人工确认的关键不确定性和可机器执行的约束。Agent 启动时总是先读取 overview 和 constitution，再按 scope、relations 与 Task 目标选择其余知识。

新增 `plan` kind 与 `.alignyard/plans/<scope>/*.md`。Plan 是 Task 级、可选、可版本化的技术方案；实现完成后可以保留为历史，但当前事实必须回到 Docs，长期取舍必须进入 ADR。模板必含“背景与目标、依据与约束、实现设计、修改范围、保持不变、实施步骤、验证方案、文档更新、未决问题”。

所有文档支持可选 `sources` 和 `governing`：

- `sources` 是仅供追溯的外部来源字符串，例如经过确认可提交的飞书 URL 或平台私有引用 `source://...`；它不是实现权威。
- `governing` 是当前 snapshot 内必须遵守的文档 ID，只能指向 constitution、Docs、Specs 或 ADRs，不能指向 Plan 本身。
- `relations` 保持现有同仓库 ID 数组语义，避免在本版同时引入通用类型化关系迁移。

服务端同时读取 v1 和 v2；`ay init` 默认生成 v2。v1 保持原有三种 kind 和最小基线，只有 v2 强制 constitution、plan 模板及新字段校验。Runner 后续可在 capability 中声明支持的知识协议版本，但本版不改变多 Repository 调度。

## 普通 Task 设计包

普通 Task Agent 默认执行：读取 Task 与原始需求、读取固定入口和相关约束、判断应新增或更新哪些 Spec/ADR/Plan/Docs、主动询问关键不确定性、运行 `ay validate`、提交必要知识改动并保持 worktree clean。明确的新功能或边界变化通常需要 Spec；已有 Spec 已覆盖、小修正或纯文档整理可以只更新现有文档。除非 Task 明确要求实现，否则不修改业务源码。

设计包遵循“最小充分”原则：只记录未来 Agent 缺少后可能做出错误整体决策的信息。函数级实现、普通字段传递、可由类型和测试直接表达的行为不写入长期文档。Spec 聚焦目标、边界与验收，ADR 聚焦一项长期取舍及原因；Plan 仅在具体技术设计能显著减少实现漂移时创建。

外部原始需求只作为适合提交到 Git 的 `sources` 或 Platform Task 元数据。实现时以审核通过的 Spec 和技术方案为准；敏感或不适合进入 Git 的链接只留在私有 Task 元数据中，不写入 `.alignyard/`。

## Review 与设计基线

`ay validate` 在 worktree 内对完整文档、固定入口、引用关系和章节进行结构校验。是否具备 Review 条件由人和 Agent 判断；Platform 不依据摘要、hash 或文档数量判断完成度。

Author 提交 Review 时，Runner 重新执行 `ay validate`，保证 worktree clean、相对基线存在新提交并推送工作分支。Reviewer 使用自己的 GitHub/GitLab 权限在 Runner 拉取远端工作分支，通过 worktree 中的完整文档、Git diff 和 Agent 辅助核对或修改；删除文件等变化直接由 Git 表达，Platform 不实现另一套 diff 或 tombstone。批准动作只由人执行。

Task 页面允许参与者从自己的 Runner worktree 按需读取符合协议的文档。Runner 临时解析后返回浏览器，Platform 不保存正文、索引或摘要；这项呈现能力不改变 Repository/worktree 的真源地位。

Review 批准时，把每个 editable Repository 当前已推送的 Review HEAD 写入 `design_commit`。普通 Task 的 `approved` 状态在产品中解释为“设计已确认 / 可开始实现”，关闭当前 Review 页面并交还发起人；不自动创建 PR/MR。Repository Init 仍需创建并合并 PR/MR，合并后刷新默认分支协议状态。

## 分支与多 Repository 扩展

目标 Docs 直接修改正常路径，Task 分支本身就是待发布状态。远端 Git 分支承担跨设备内容真源，Platform 只记录工作分支、必要的 base/head commit 和设计基线，不计算默认分支与 Task 分支的内容差异。

`design_commit` 放在 `platform_task_repositories`，而不是 Task 主表。未来放开多个 editable Repository 时，每个 Repository 独立拥有 `base_branch`、`base_commit`、`work_branch`、`head_commit`、`design_commit` 和 execution；Task 只聚合 Review 与整体状态。本版继续由 Runner 工作流拒绝多个 editable Repository。

# 验收标准

- v1 Repository 继续通过校验；`ay init` 新建 v2 Repository，并生成 constitution、四份模板和更新后的 Skill。
- `ay new plan` 能创建合法技术方案；v2 校验 sources、governing、必需章节、固定入口和悬空引用。
- `ay` 不提供知识上传命令；Platform schema 不保存工程知识、摘要或 content hash。
- Reviewer 能在自己的 Runner 拉取远端工作分支，通过 Git diff 和 Agent 阅读、修改完整设计包，包括被删除的文件；Task 页面可按需读取 Reviewer 自己 worktree 的协议文档且不持久化。
- 普通 Task Prompt 以知识设计为默认目标，明确不确定时直接询问用户，并明确不默认编码。
- 普通 Task Prompt 使用“最小充分”判断，不强制每个 Task 新建 Spec，也不把可由源码表达的细节搬进长期文档。
- 提交 Review 时 Runner 执行 `ay validate`、clean worktree、新提交与 push 检查；批准后记录各 Repository 的 `design_commit`。
- 普通 Task 批准后停在“可开始实现”，不会提示或自动推进 PR/MR；Repository Init 保持现有 PR/MR 合并闭环。
- Task 分支中的 Docs 使用正常路径，协议和工作流中不存在 temp Docs 清理步骤。
- 多 Repo 字段按 Repository 维度保存，且现有单 editable Repository 限制和错误信息保持明确。
- 协议、Platform、Runner 与 Web 测试覆盖新增语义，`npm test`、TypeScript 检查、`ay validate` 与 `git diff --check` 通过。

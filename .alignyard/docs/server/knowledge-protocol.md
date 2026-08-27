---
id: doc.server.knowledge-protocol
title: "Alignyard 工程知识协议"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.overview
  - doc.shared.constitution
  - doc.shared.development
  - doc.server.cli-configuration
  - doc.server.http-api
  - spec.shared.knowledge-first-task
  - spec.server.framework-update
---

# 概述

Alignyard 工程知识协议把核心工程意图与架构约束版本化在 `.alignyard/`。它不是源码百科：只记录未来 Agent 缺少时可能导致整体设计漂移的信息，具体实现事实继续由代码、类型、测试和运行行为承担。`server/protocol/repository.ts` 负责本地结构、完整校验和 worktree 索引，`server/protocol/cli.ts` 提供 `ay`。Platform 不维护工程知识副本或摘要。

## 目录契约

```text
.alignyard/
  repository.yaml
  README.md
  templates/{doc,spec,adr,plan}.md
  skills/alignyard-knowledge/SKILL.md
  docs/<scope>/*.md
  specs/<scope>/*.md
  adrs/<scope>/*.md
  plans/<scope>/*.md
```

服务端兼容 `version: 1` 和 `version: 2`，`ay init` 默认创建 v2；两者都使用 `preset: basic` 并至少声明 `shared`。`version` 表示文档结构与校验契约，独立的 `framework_version` 表示 Skill、模板、README 和固定骨架的发布版本；旧 Repository 缺失时按 legacy v0 读取。v2 还必须声明 `entrypoints.overview: doc.shared.overview` 与 `entrypoints.constitution: doc.shared.constitution`。scope ID 使用小写字母、数字和连字符；可选 `source` 必须是仓库内安全相对路径，而且 `ay validate` 会检查路径存在。scope 表示有意义的应用或服务边界，不应机械复制所有目录。

v1 Repository 被平台判定为完成初始化时，默认分支必须包含 manifest、README、三份模板、Skill 和 shared overview；v2 还必须包含 Plan 模板与 `.alignyard/docs/shared/constitution.md`。Runner refresh 根据 manifest version 选择有界基线文件；详细内容仍以 `ay validate` 与人工 Review 为准。

## 文档语义

- Docs 记录当前有效、会影响后续设计方向的架构事实、模块边界、稳定接口和关键数据流；初始化必须有 `doc.shared.overview`，但 overview 只做全貌和导航。
- Specs 是一次变化的意图契约，记录目标、允许改变与不能破坏的边界及验收标准。明确的新能力通常需要 Spec；小修正、纯文档整理或已有 Spec 已覆盖时不强制新建。
- ADRs 一份只记录一项有明确替代方案或长期影响的决策、原因及后果，不保存讨论过程。
- Plans 是可选的 Task 级技术方案，负责把权威需求和长期知识转成可执行设计，必含背景与目标、依据与约束、实现设计、修改范围、保持不变、实施步骤、验证方案、文档更新和未决问题。
- v2 Constitution 是保留 ID `doc.shared.constitution` 的固定入口 Doc，记录 Repository 级产品意图、工程边界、人工确认规则与已有机器检查。

文档必须有 `id`、`title`、`kind`、`scope`，并可使用 `relations`、`sources` 与 `governing` 字符串数组。历史 `owners` 字段继续兼容，但不作为作者追溯机制；作者、修改者与审核人使用 Git commit、Git blame、PR/MR 和 Alignyard Review 追溯。`sources` 记录仅供参考的外部来源；`governing` 记录当前文档必须遵守的 snapshot 文档 ID，不能指向自身或 Plan。Plan 必须受 constitution 约束，并只引用实际约束本次实现的 Docs、Specs 与 ADRs；新能力通常需要 Spec，但已有知识已经清楚表达意图时不强制创建。文件位于对应 kind 与 scope 目录，ID 采用 `<kind>.<scope>.<slug>`；`relations`、`governing` 只能引用当前快照内存在的文档 ID。初始化任务中的 title、正文和每个 Markdown 章节标题必须含中文；代码标识符、命令、路径、API 和产品名保持原样。

所有内容遵守最小充分原则：如果一条信息缺失不会让 Agent 做出错误的整体设计决定，就不应为了“完整”写入 `.alignyard/`。具体函数调用、局部算法、普通字段流转和实现日志留在代码、测试、注释或 Task 会话中。

## 业务语义与边界契约

Alignyard 不为每个业务领域分别建立规则清单，而是统一处理“同一业务概念跨边界后是否仍保持同一语义”。业务概念的权威定义、不同边界的表示差异以及必须保持的不变量，是稳定接口的一部分；字段类型、序列化方式和局部转换代码仍属于实现。

初始化时，Agent 从主要数据流和系统边界中识别那些仅看局部代码容易误解的概念，把当前语义与边界契约写入对应 scope 的 Docs，并通过 overview、scope 与 relations 保持可发现。普通 Task 开始时先识别受影响的业务概念和边界，再读取两侧适用 Docs 与 ADRs，将源与目标语义判断为等价、不同或未知：

- 等价必须有权威文档或仓库证据支持，不能仅凭字段同名、类型相同或自然语言中的简写判断；
- 表示不同时，Spec 通过 `governing` 引用两侧真正适用的 Docs/ADRs，并明确归一化或映射规则、保持不变的业务含义和代表性边界示例；
- 含义未知且会影响设计结果时，Agent 在当前会话向用户确认，再把结论写回 Doc、Spec 或 ADR；
- 持续变化的运行数据不进入 `.alignyard/`；只有它的权威来源、解释方式、生命周期或兜底策略会约束设计时，才记录长期规则。

这套机制不增加新的文档类型。Docs 保存当前语义，Spec 描述本次变化和映射，ADR 解释长期选择，Plan 可选地展开实现。Agent Harness、hooks 和 CI 可以读取这些文档 ID 并执行相应检查，但只负责工作方式和机器执行，不成为项目知识的第二真源；Alignyard 也不管理 Harness 自身的安装、版本或同步。

## 创建与校验

新文档必须通过以下命令从仓库模板创建，再填正文和关系：

```sh
ay new doc <slug> --scope <scope> --title '<中文标题>'
ay new spec <slug> --scope <scope> --title '<中文标题>'
ay new adr <slug> --scope <scope> --title '<中文标题>'
ay new plan <slug> --scope <scope> --title '<中文标题>'
```

`ay validate .` 检查 manifest、固定入口、scope source、模板变量、Skill、符号链接、frontmatter、kind/path/scope/ID 一致性、必需章节、重复 ID 与悬空 relations/governing，并要求 shared overview；v2 还要求 constitution。它不判断事实是否准确、是否足够精简，也不会替代人工内容 Review。

## 框架版本更新

`ay init` 只幂等补齐缺失的首次初始化文件，不覆盖已存在框架，也不承担升级。已初始化 Repository 使用：

```sh
ay update --check .
ay update .
ay validate .
```

`--check` 只返回待创建、替换或合并的路径。`ay update` 将 manifest 合并到当前协议与框架版本，替换 Alignyard 管理的 README、默认模板和 Skill，并补齐缺失的 Constitution 和 scope 目录；它不覆盖已有 Docs、Specs、ADRs、Plans，也不改文档 ID 与关系。Update Agent 必须按实际 Git diff 核对管理文件替换、manifest 合并和固定结构补齐，默认不精简、复核或重写知识正文；只有协议兼容性明确要求或用户明确提出时才做最小语义修改。完成前再次运行 `ay update --check` 并确认无待应用变化。知识维护通过普通 Task 单独发起。重复运行无变化；Repository 声明的框架版本高于当前 `ay` 时必须先升级 Runner，不能用旧工具降级。

Runner 从默认分支执行 `repository.refresh-protocol`，比较 Repository 与自身内置的框架版本。Platform 只记录版本和 `uninitialized`、`invalid`、`outdated`、`ready` 状态元数据；Web 自动刷新并为 `outdated` Repository 提供 Update Task。真正的更新发生在用户 Runner 创建的 Task worktree，沿用 Agent、Review、PR/MR 和合并链路，Platform 不保存升级后的知识副本。

## Review 校验与按需阅读

工程文档没有上传或同步命令。用户与 Agent 根据内容判断是否具备审核条件；Platform 不维护“知识已完成”、摘要 hash 或文档审核状态。

用户点击提交 Review 时，Runner 对 Author worktree 执行固定检查：

1. 运行与 `ay validate .` 相同的完整协议校验；
2. 要求 `git status --short` 为空；
3. 要求 HEAD 相对 Task 基线存在新提交；
4. 将 HEAD push 到 Task 工作分支，随后 Platform 只记录 branch、base/head commit、Review 参与人和状态。

Reviewer 通过自己的 Runner 和 GitHub/GitLab 权限拉取工作分支，在独立 worktree 中使用 Git diff 与 Agent 阅读、修改和审核完整内容。Task 页面可要求该 Runner 以 Task 创建时记录的默认分支 commit 为不可变基线生成完整 diff；Reviewer worktree 从 Author 分支 checkout 不会把 Author HEAD 错当成审核基线。删除文件等变化天然由 Git diff 表达，Platform 只转发当次响应，不实现第二套 diff、持久化副本或 tombstone。Reviewer 修改并批准时，Runner 对 Reviewer worktree 执行同一组检查，并将结果 push 回 Task 工作分支。

Task 页面可以经当前用户自己的 execution 调用 `execution.knowledge`。Runner 临时索引该 worktree：列表只返回协议文档元数据，用户选择文档后才返回正文。响应只用于当前页面呈现，不写入 Platform SQLite、日志或缓存；未启动自己 execution 的参与者不能借用其他人的 worktree 读取内容。

## 初始化维护流程

1. 运行 `ay init .` 并完整阅读生成的 Skill。
2. 以 README、manifest、docs、CI、入口、主要目录和测试建立证据清单，再规划 scopes、constitution 与长期主题；沿主要数据流检查同一业务概念在不同边界是否存在不易察觉的语义或表示差异。
3. 只用 `ay new` 创建必要文档；使用“缺少这条信息是否会让 Agent 写出局部正确、整体跑偏的实现”判断是否纳入，不为目录、主题数量或形式完整创建文档。
4. 检查产品意图、系统边界、稳定接口、长期取舍和明确不可改变行为是否有足够约束，同时删除可由源码直接推导的重复细节。
5. 运行 `ay validate .`，复查 overview 导航，提交 `.alignyard/` 并确保 worktree clean；用户确认后由 Platform 的提交 Review 动作完成复检和 push。

普通 Task 先读取 overview、constitution 和相关约束，识别受影响的业务概念与边界，再按变化性质决定新增或更新 Spec、ADR、Plan、Docs。明确的新功能通常形成 Spec，但平台不强制每个 Task 创建主文档；目标是最小充分且能直接约束后续实现。关键不确定性直接在当前 Agent 会话向用户确认，结论进入最终文档，不创建独立决策实体。人工 Review 通过后记录 Repository 级 `design_commit`；普通 Task 停在可开始实现，Repository Init 才继续 PR/MR 合并闭环。已有文档 ID 应保持稳定。

---
id: doc.server.knowledge-protocol
title: "Alignyard 工程知识协议"
kind: doc
scope: server
owners: []
relations:
  - doc.shared.overview
  - doc.shared.development
  - doc.server.cli-configuration
  - doc.server.http-api
---

# 概述

Alignyard 工程知识协议把可长期复用的仓库知识版本化在 `.alignyard/`。本仓库自身同时实现协议客户端与平台接收端：`server/protocol/repository.ts` 负责本地结构，`server/protocol/cli.ts` 提供 `ay`，`server/platform/sync.ts` 校验并保存 Task 知识快照。

## 目录契约

```text
.alignyard/
  repository.yaml
  README.md
  templates/{doc,spec,adr}.md
  skills/alignyard-knowledge/SKILL.md
  docs/<scope>/*.md
  specs/<scope>/*.md
  adrs/<scope>/*.md
```

`repository.yaml` 当前必须使用 `version: 1` 与 `preset: basic`，至少声明 `shared`。scope ID 使用小写字母、数字和连字符；可选 `source` 必须是仓库内安全相对路径，而且 `ay validate` 会检查路径存在。scope 表示有意义的应用或服务边界，不应机械复制所有目录。

Repository 被平台判定为完成初始化时，默认分支必须包含 manifest、README、三份模板、Skill 和 `.alignyard/docs/shared/overview.md`。`server/platform/protocol.ts` 的 refresh 只做这组有界基线检查；详细内容仍以 `ay validate` 与人工 Review 为准。

## 文档语义

- Docs 记录当前已接受事实；初始化必须有 `doc.shared.overview`，但 overview 只做全貌和导航。
- Specs 记录目标和边界已经明确、但尚未完成的变更，必含背景、目标、非目标、设计和验收标准。
- ADRs 只记录有仓库证据的长期决策及影响，必含背景、决策和影响。

每个文件必须有 `id`、`title`、`kind`、`scope`、`owners` 和 `relations` frontmatter。文件位于对应 kind 与 scope 目录，ID 采用 `<kind>.<scope>.<slug>`；`relations` 只能引用当前快照内存在的文档 ID。初始化任务中的 title、正文和每个 Markdown 章节标题必须含中文；代码标识符、命令、路径、API 和产品名保持原样。

## 创建与校验

新文档必须通过以下命令从仓库模板创建，再填正文和关系：

```sh
ay new doc <slug> --scope <scope> --title '<中文标题>'
ay new spec <slug> --scope <scope> --title '<中文标题>'
ay new adr <slug> --scope <scope> --title '<中文标题>'
```

`ay validate .` 检查 manifest、scope source、模板变量、Skill、符号链接、frontmatter、kind/path/scope/ID 一致性、必需章节、重复 ID 与悬空 relation，并要求 shared overview。它不判断事实是否准确、主题是否遗漏，也不会替代内容完整性检查。

## 同步契约

`ay sync` 先调用与 validate 相同的索引逻辑，读取全部协议文档，计算 SHA-256 和 HEAD。提供 `base_commit` 时，每个文档标记为 `added`、`modified` 或 `unchanged`；未提供时标记 `snapshot`。客户端向 `/api/platform/tasks/:key/sync` 发送完整 manifest 和完整文档集合，缺席路径会从该 Task/Repository 的平台快照删除。

平台接收端还执行以下限制：

- Task 必须存在、尚未 approved，并且目标 Repository 必须以 `editable` 方式关联。
- 最多 500 个文档，单文档不超过 1 MiB，总内容不超过 8 MiB。
- path 必须位于 `.alignyard/<kind-directory>/<scope>/`，禁止 `..` 与反斜杠；content hash、frontmatter 和索引元数据必须一致。
- ID 与 path 不得重复，relation 必须能在同次完整快照中解析。
- Repository 初始化 Task 必须包含 `.alignyard/docs/shared/overview.md`，并满足中文要求。

成功同步后，平台以 `(task_id, repository_id, path)` upsert `platform_artifacts`，记录 base/head commit，并把 Task-Repository 的 `manifest_status` 设为 `valid`。相同内容保留已有 review 状态；内容 hash 变化会重新标记为 `unreviewed`。

## 初始化维护流程

1. 运行 `ay init .` 并完整阅读生成的 Skill。
2. 以 README、manifest、docs、CI、入口、主要目录和测试建立证据清单，再规划 scopes 与长期主题。
3. 只用 `ay new` 创建必要文档；不为数量创建 Spec/ADR。
4. 检查每个 scope 和适用主题是否有文档、由 overview 明确覆盖，或有基于证据的省略理由。
5. 运行 `ay validate .`，复查 overview 导航，提交 `.alignyard/` 后运行带 Task、Repository ID 与 merge-base 的 `ay sync`。

普通 Task 后续修改当前行为时应同步更新 Docs；只有明确的未完成变更才新增 Spec，只有出现有依据的长期决策才新增 ADR。已有文档 ID 应保持稳定。

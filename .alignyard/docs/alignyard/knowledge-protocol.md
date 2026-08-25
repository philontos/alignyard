---
id: doc.alignyard.knowledge-protocol
title: "工程知识协议"
kind: doc
scope: alignyard
owners: []
relations:
  - doc.alignyard.overview
  - doc.alignyard.task-workflow
  - doc.shared.development-workflow
---

# 概述

Alignyard 工程知识协议把可长期复用的仓库事实放在版本化 `.alignyard/` 中。`server/protocol/repository.ts` 是结构权威，`server/protocol/cli.ts` 提供 `ay init/new/validate/sync`。协议当前版本为 `1`，preset 固定为 `basic`。

## 目录与路由契约

最小初始化基线包括：

```text
.alignyard/
  repository.yaml
  README.md
  templates/{doc,spec,adr}.md
  skills/alignyard-knowledge/SKILL.md
  docs/shared/overview.md
```

`repository.yaml` 必须声明 `version: 1`、`preset: basic` 和至少一个 scope，并且必须包含 `shared`。scope id 使用小写字母、数字和连字符；`source` 可选，只能是仓库内安全相对路径且必须存在。scope 表示稳定应用或服务边界，不应机械复制每个源码目录。

知识文件分别位于 `.alignyard/docs/<scope>/`、`.alignyard/specs/<scope>/`、`.alignyard/adrs/<scope>/`。路径、frontmatter `kind`、`scope` 和 id 必须一致；id 形如 `doc.shared.overview`。`relations` 只能引用已存在文档 id，不允许重复或自引用。知识树与模板不允许符号链接。

## 文档语义

- Doc 记录当前已验证、可被后续成员依赖的系统事实，至少有“概述”章节。
- Spec 记录已有明确目标但尚未完成的变更，必须包含“背景、目标、非目标、设计、验收标准”。
- ADR 记录已有明确依据的长期决策及原因，必须包含“背景、决策、影响”。

初始化不要求凑齐三种类型。没有明确未完成目标时不建 Spec，没有明确决策依据时不建 ADR。overview 只做边界地图与导航；拥有独立证据并会独立演进的 CLI、API、协议或维护流程应拆为单独 Doc。

初始化 Task 中，所有 Doc/Spec/ADR 的 title、章节标题和正文必须含中文；代码标识符、命令、路径、API 名称和产品名保持原样。Skill 本身可以使用英文。

## 命令契约

| 命令 | 行为 |
|---|---|
| `ay init [repository]` | 幂等创建最小 scaffold，不覆盖现有文件 |
| `ay new <doc\|spec\|adr> <slug> --scope <scope> [--title <标题>]` | 从仓库模板创建一个新文件；scope 必须已声明，目标存在时拒绝 |
| `ay validate [repository] [--json]` | 校验 manifest、模板、Skill、文档元数据、章节、id、路径和 relations |
| `ay sync [repository] --platform <url> --task <AY-key> --repository-id <id> [--base-commit <commit>]` | 先完整校验，再向平台同步当前知识快照 |

路径位置参数与 `--repository` 不能同时使用。sync 参数也可由 `AY_PLATFORM_URL`、`AY_TASK_KEY`、`AY_REPOSITORY_ID`、`AY_BASE_COMMIT` 提供；`AY_API_URL` 是平台地址兼容名。`AY_SESSION_TOKEN` 若存在，仅作为 Bearer header 使用，不能写进文档或提交。

## 校验与索引

`ay validate` 读取所有知识 Markdown，检查 YAML frontmatter 和规定章节，再验证 document id 唯一、文件路径唯一和关系目标存在。通过后，索引器读取完整内容并计算 SHA-256 `content_hash`。结构校验不评价事实是否完整，因此初始化还必须人工检查每个 scope 和适用长期主题是否被覆盖。

当前 Repository Init 的默认分支就绪检查比完整校验更窄：它只读取 `repository.yaml` 和固定基线文件并解析 manifest。详细内容仍以 worktree 中的 `ay validate` 及随后的 `ay sync` 为准。

## 同步协议

`ay sync` 解析当前 Git `HEAD`，并相对可选 `base_commit` 将每份文档标为 `snapshot`、`added`、`modified` 或 `unchanged`。请求发送到 `/api/platform/tasks/<key>/sync`，包含 repository id、manifest、base/head commit 和文档索引/正文。

平台只接受 Task 已关联且模式为 `editable` 的 Repository；`approved` Task 不能继续同步。每个请求最多 500 份文档，单份内容最多 1 MiB，总内容最多 8 MiB。平台重新校验路径、frontmatter、hash、scope 和 change kind，并对 Repository Init 强制要求 `.alignyard/docs/shared/overview.md` 及中文内容。内容 hash 变化会把 artifact 的 `review_status` 重置为 `unreviewed`；本次未再出现的旧路径会从该 Task/Repository 快照删除。

## 维护流程

1. 读取 `repository.yaml`、相关 scope Doc、活跃 Spec 和 ADR。
2. 只把长期稳定的当前事实写入 Doc；需求明确后再建 Spec；只有决策依据充足时才建 ADR。
3. 使用 `ay new` 创建文件，保留既有 document id，并只建立有语义的 relations。
4. 做内容完整性复查，再运行 `ay validate .`。
5. 与平台 Task 协作时，在提交后用准确 base commit 运行 `ay sync`。

不要把临时讨论、实现流水账、秘密值、依赖生成物或大文件纳入 `.alignyard`。

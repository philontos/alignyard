---
id: spec.server.framework-update
title: "知识框架版本更新"
kind: spec
scope: server
relations: []
sources: []
governing:
  - doc.shared.constitution
  - adr.shared.node-local-ownership
  - adr.shared.platform-runner-separation
---

# 背景

Alignyard 的协议、Skill、模板和知识写法会持续演进。`ay init` 只负责首次建立骨架，而且不会覆盖已有文件；如果已初始化 Repository 只能删除 `.alignyard/` 重来，就会丢失已经审核的核心工程意图，也无法区分“协议结构升级”与“知识正文重写”。

Platform 不能保存或改写 Repository 知识。版本检测和文件更新必须在用户 Runner 与 Task worktree 内完成，使用用户自己的 Git 权限，最终仍由人工 Review 和 PR/MR 决定是否进入默认分支。

# 目标

- 为 `.alignyard/` 增加独立 `framework_version`，与文档结构兼容性使用的 `version` 分开演进。
- 提供 `ay update --check` 预览和幂等 `ay update`，升级 Alignyard 管理的框架文件而不覆盖 Repository 知识正文。
- 让 Runner 从默认分支自动识别未初始化、无效、已就绪或框架可更新，并把协议版本元数据返回 Platform。
- 在 Platform 为可更新 Repository 提供 Update Task，复用 Agent、人工 Review、PR/MR 和合并闭环。
- 更新后由 Agent 按新版 Skill 核对实际 diff 与结构兼容性，默认不整理或重写现有知识；必要的语义变化必须有协议要求或用户明确指令，并进入 Git diff 和人工 Review。
- 保持 Platform 轻量：只记录 Repository、Task、版本与流转元数据，不保存知识、摘要或 diff。

# 非目标

- 不自动重写 Docs、Specs、ADRs 或 Plans，也不根据模板机械迁移正文。
- 不把框架更新当作知识精简、事实复核或内容维护 Task；这些工作通过普通 Task 单独发起。
- 不在 Platform 上执行 Git、`ay update` 或知识解析，不为版本升级建立 Platform 知识副本。
- 不让 `ay init` 承担升级职责，也不要求删除 `.alignyard/` 后重新初始化。
- 不实现无人确认的自动 PR/MR、自动合并或默认分支直接写入。
- 不保证旧 Runner 能识别其发布之后才出现的框架版本；用户需先升级 Runner 制品。

# 设计

`repository.yaml` 同时声明两个版本：

- `version` 表示文档结构与校验契约；当前支持 v1、v2，`ay update` 会升级到当前协议版本。
- `framework_version` 表示 Alignyard 管理文件的发布版本；缺失时按 legacy v0 处理，当前最新版为 v2。

`ay update --check [repository]` 只计算 `create`、`replace`、`merge` 变化，不写文件。`ay update [repository]` 执行同一计划：合并 `repository.yaml`，替换 `.alignyard/README.md`、默认模板与 `alignyard-knowledge` Skill，补齐缺失的 Constitution、kind/scope 目录。它保留 scopes 及扩展字段，不修改已有 Docs、Specs、ADRs、Plans、文档 ID、relations、sources 或 governing；重复运行没有变化。

升级后的 Agent 先阅读新 Skill，再检查 `ay update --check` 的计划和升级后的实际 Git diff，将变化归为管理文件替换、manifest 结构合并或缺失固定结构补齐。已有知识正文默认保持不变；只有协议兼容性明确要求或用户明确提出时才做最小语义修改，涉及产品意图、公共接口、架构边界或兼容性时直接在会话中询问用户。完成前再次运行 `ay update --check` 并确认没有待应用变化。Update Task 只允许修改 `.alignyard/`，运行 `ay validate`、提交并等待人工 Review。

Runner 的 `repository.refresh-protocol` 从 Repository 默认分支读取 manifest 与有界的初始化文件，比较 Repository `framework_version` 和当前 Runner 内置版本，返回 `uninitialized`、`invalid`、`outdated` 或 `ready`。Platform 保存 `protocol_version`、`framework_version` 与状态元数据；Web 定期经当前用户 Runner 刷新，`outdated` 时显示 Update 入口。Update Task 使用独立 `repository_update` 类型，但复用现有 Author、Reviewer、change request 与 merge 状态机；合并后必须再次检测为 `ready` 才能完成。

框架真源在 Alignyard 源码和发布的 Runner 制品中，Repository 的 `.alignyard/` 保存已采用的版本与知识；Platform 只协调检测和流转。若 Repository 声明的 `framework_version` 高于当前 Runner 支持版本，校验失败并提示先升级 Runner，避免旧工具降级覆盖新框架。

# 验收标准

- `ay init` 新 Repository 写入当前 `framework_version`；旧 manifest 缺少该字段时仍可读取并标记为 legacy v0。
- `ay update --check` 不修改文件并准确列出变化；`ay update` 可从 v1/v2 legacy 骨架升级且第二次运行无变化。
- 更新只替换明确的 Alignyard 管理文件，保留 scopes、扩展字段和全部 Repository 知识正文。
- Update Agent 按实际 diff 分类核对升级，不会默认精简、复核或重写已有知识正文；完成前第二次 `ay update --check` 无待应用变化。
- `ay validate` 输出当前协议版本、框架版本、最新版和是否可更新；高于当前工具的版本给出 Runner 升级提示。
- Runner refresh 返回版本元数据和 `outdated` 状态；Platform 自动刷新并为其创建幂等 Update Task。
- Update Agent 收到专用 Prompt，人工 Review 通过后才能创建 PR/MR，合并后 Repository 必须为 `ready`。
- Platform 数据库不增加知识正文、摘要或 diff 存储。
- 协议、catalog、Runner workflow、Web 与 schema 回归测试通过，完整 `npm test`、`ay validate` 和 `git diff --check` 通过。

---
id: plan.server.plan-task-ledger
title: "细粒度 Plan 实施任务账本方案"
kind: plan
scope: server
relations: []
sources: []
governing:
  - doc.shared.constitution
  - doc.server.knowledge-protocol
  - spec.server.plan-task-ledger
---

# 背景与目标

按 `spec.server.plan-task-ledger` 实现 protocol v3/framework v4，使 Alignyard Plan 同时承担可执行技术方案和持续更新的实施账本，并保持旧协议兼容。

# 依据与约束

- `doc.shared.constitution` 约束工程知识与实现真源边界、人工 Review 和机器检查。
- `doc.server.knowledge-protocol` 定义 CLI、manifest、文档结构、framework update 与兼容性边界。
- `spec.server.plan-task-ledger` 定义本次行为、兼容性和验收标准。
- v1/v2 Repository 未显式升级时不能因安装新版 `ay` 而失效。
- `ay update` 继续不自动改写已有知识正文。

# 实现设计

在 `server/protocol/repository.ts` 中将必需章节和 Plan 任务校验按 protocol version 分流。v3 使用逐行解析器限定“实施任务”章节：识别 Phase、直属 checkbox 任务和任务字段，并输出带文件路径与任务编号的确定性错误。现有全局引用解析完成后，再检查 Plan 的必要 governing 目标。

`.alignyard/templates/plan.md`、源码内嵌模板和内嵌 Skill 必须同步修改；Repository 自身 manifest、协议文档与相关 Spec 采用 v3/v4。测试覆盖生成、正向校验、每类负向校验、v2 兼容和 framework update。

# 修改范围

- `server/protocol/repository.ts` 及 protocol/CLI tests。
- `.alignyard/templates/plan.md`、`.alignyard/skills/alignyard-knowledge/SKILL.md` 及对应内嵌生成源。
- `.alignyard/repository.yaml`、协议/开发文档、相关 Spec 和 Runner `VERSION`。

# 保持不变

- 文档 kind 仍为 `doc/spec/adr/plan`，不增加独立任务文档。
- Docs/Specs/ADRs 继续承载架构、契约和长期决策，Plan 不成为第二套业务真源。
- v1/v2 解析和既有 Plan 校验语义保持兼容。
- Platform/Runner ownership、Review 状态机和数据库结构不变。

# 实施任务

## P0 协议与框架结构

- [x] P0.1 建立变更 Spec、Plan 与版本兼容设计
  - 依赖：无
  - 产出：可 Review 的目标、非目标、v3/v4 兼容策略和实施账本
  - 完成标准：Spec/Plan 关联 Constitution 与协议文档，任务可独立追踪
  - 验证：`npm run -s ay -- validate .`
  - 验证结果：通过；17 documents、3 scopes、protocol v3、framework v4
- [x] P0.2 更新 protocol/framework/Runner 版本及 Plan 模板和 Skill
  - 依赖：P0.1
  - 产出：protocol v3、framework v4、Runner 0.1.12 与一致的受管理文件生成源
  - 完成标准：新 Plan 默认包含 Phase、checkbox、任务字段和维护说明
  - 验证：`npm run -s ay -- update . --check`
  - 验证结果：通过；`update_available:false`，无受管理文件漂移

## P1 校验与回归测试

- [x] P1.1 实现 v3 Plan 任务结构与必要关联校验
  - 依赖：P0.2
  - 产出：版本感知的章节、Phase、任务编号、字段、占位符和 governing 校验
  - 完成标准：错误定位稳定，v1/v2 行为保持兼容
  - 验证：`node --import tsx --test server/protocol/repository.test.ts`
  - 验证结果：通过；repository protocol 定向用例覆盖 v1/v2/v3
- [x] P1.2 补齐 repository 与 CLI protocol tests
  - 依赖：P1.1
  - 产出：默认生成、正向、负向、旧版兼容与 update 覆盖
  - 完成标准：验收标准中的结构错误均有独立断言
  - 验证：`node --import tsx --test server/protocol/repository.test.ts server/protocol/cli.test.ts`
  - 验证结果：通过；19/19 protocol 与 CLI tests

## P2 文档同步与整体验证

- [x] P2.1 同步协议知识、受管理文件和 Repository 自身 manifest
  - 依赖：P1.2
  - 产出：知识协议、相关 Spec、模板、Skill 与生成源的一致版本
  - 完成标准：`ay update --check` 无待应用变化且 `ay validate` 通过
  - 验证：`npm run -s ay -- update . --check && npm run -s ay -- validate .`
  - 验证结果：通过；源码版 `ay update --check` 无漂移，17 documents 自校验通过
- [x] P2.2 执行完整测试、类型检查和 diff 检查
  - 依赖：P2.1
  - 产出：可提交的上游变更与验证记录
  - 完成标准：全部验证通过，无未解释失败或未完成任务
  - 验证：`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null npm test && npx tsc --noEmit --allowImportingTsExtensions && npm run build:runner:macos && git diff --check`
  - 验证结果：通过；隔离用户级 Git hook 后 244/244 tests 通过，带仓库所需 `allowImportingTsExtensions` 的 TypeScript 检查、`git diff --check` 与 darwin-arm64 Runner/`ay` 0.1.12 制品构建均通过；未经隔离的 `npm test` 会受用户级 `core.hooksPath` 干扰，未带该 TypeScript 选项的命令会触发现有 TS5097

# 验证方案

先运行 protocol 定向测试，再隔离用户级 Git hook 运行完整 `npm test`，以 `npx tsc --noEmit --allowImportingTsExtensions` 执行仓库兼容的类型检查，并运行源码版 `ay update --check`、源码版 `ay validate .`、Runner 制品构建与 `git diff --check`。使用临时 Repository 覆盖 v2 旧 Plan 和 v3 新 Plan，避免只验证 Alignyard 自身无 Plan 的快乐路径。

# 文档更新

更新 `doc.server.knowledge-protocol`、`spec.shared.knowledge-first-task`、`spec.server.framework-update`、`.alignyard/README.md` 和生成 Skill；新增本 Spec/Plan 并从协议文档建立导航关系。

# 未决问题

无。首轮不实现 `ay status`；后续可基于已验证的任务语法汇总未完成项。

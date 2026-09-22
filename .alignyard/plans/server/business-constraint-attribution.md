---
id: plan.server.business-constraint-attribution
title: "业务约束署名与 Review 闭环实施"
kind: plan
scope: server
relations: []
sources: []
governing:
  - doc.shared.constitution
  - spec.server.business-constraint-attribution
---

# 背景与目标

实现已确认的业务关键约束、决策日志、便捷署名与 Review 闭环，范围以关联 Spec 为准。

# 依据与约束

沿用现有文档类型、Git 真源和本机 Runner；不新增 Platform 持久化模型。

# 实现设计

CLI 增加 `--constraint` 与 `--author`；创建器仅为业务约束 Doc 和 ADR 填入可选 author。更新模板提示、生成 Skill、Review prompt 和使用说明，framework 升至 v5，Runner 升至 0.1.13，协议保持 v3。

# 修改范围

server/protocol、server/platform/prompts.ts、相关测试、Runner VERSION、框架管理文件和本仓知识文档。

# 保持不变

普通 Doc、Spec、Plan、Constitution 的既有结构与校验，审批状态机、权限、UI 和业务仓库历史正文。

# 实施任务

## P0 创建与署名

- [x] P0.1 实现兼容的署名与 CLI 入口
  - 依赖：已确认 Spec
  - 产出：创建器、CLI、模板提示和行为测试
  - 完成标准：自动和手动署名可用，身份缺失不阻止创建，普通文档不变
  - 验证：`node --import tsx --test server/protocol/*.test.ts`
  - 验证结果：protocol/CLI 共 23 项测试通过，覆盖自动署名、显式覆盖、身份缺失、手动修改/删除及升级保留。

## P1 使用与 Review

- [x] P1.1 更新框架规则和 Review 闭环
  - 依赖：P0.1
  - 产出：Skill、README、Review 提示及本仓知识
  - 完成标准：能对照旧规则找出冲突，确认后同步当前约束与新决策
  - 验证：`node --import tsx --test server/platform/runner-workflow.test.ts`；`npm run -s ay -- validate .`
  - 验证结果：Runner workflow 12 项测试通过；ay validate 校验 20 份文档通过；ay update --check 无待更新。

## P2 发布与验证

- [x] P2.1 准备版本与发布说明并完成回归
  - 依赖：P1.1
  - 产出：framework v5、Runner 0.1.13、发布与采用说明
  - 完成标准：类型、测试、知识校验通过，发布路径可执行且未执行线上部署
  - 验证：`npx tsc --noEmit --allowImportingTsExtensions`；`npm test`；`npm run -s ay -- update --check .`；`git diff --check`
  - 验证结果：TypeScript 检查、全量 248 项测试、ay validate（21 份文档）、update 幂等检查和 git diff --check 均通过；arm64 Runner 0.1.13 打包及校验和、包内 ay 创建/署名/校验冒烟通过。未部署、未安装、未修改业务仓库。

# 验证方案

重点验证署名可编辑与可缺失、Git 目标仓库身份、旧知识保留、升级幂等及普通文档不变。全量回归覆盖现有 Task/Review 流程。

# 文档更新

同步知识协议、CLI 说明、Constitution 中与本次署名冲突的旧约定，以及部署说明；其他知识保持原样。

# 未决问题

无。发布和业务仓库采用由后续发布操作完成，本任务交付实现与明确步骤。

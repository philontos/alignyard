import path from "node:path";
import type { PlatformTask } from "./catalog.js";
import { PlatformWorkflowError } from "./errors.js";

function editableRepository(task: PlatformTask) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) throw new PlatformWorkflowError(409, "Task 缺少 editable Repository");
  return repository;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function repositoryInitializationPrompt(input: {
  root?: string;
  ayCommand?: string;
  task: PlatformTask;
}): string {
  const repository = editableRepository(input.task);
  const tsx = input.root ? path.join(input.root, "node_modules", ".bin", "tsx") : "";
  const entry = input.root ? path.join(input.root, "server", "ay.ts") : "";
  const ay = input.ayCommand || `${shellArg(tsx)} ${shellArg(entry)}`;
  return `你正在执行 Alignyard 平台的 Repository 初始化 Task ${input.task.key}。

目标：只在当前 Task worktree 中为 ${repository.name} 建立准确、最小充分、可评审的核心工程意图与架构约束。初始化不是“尽可能多地描述仓库”，而是让后续 Agent 明确哪些设计可以自由实现、哪些意图和边界不能自行改变。

请自主完成以下流程，不要等待用户逐条确认：
1. 运行 ${ay} init .，然后完整阅读生成的 .alignyard/skills/alignyard-knowledge/SKILL.md；后续步骤以该 Skill 为工作规范。
2. 盘点证据：阅读仓库 README、package/workspace metadata、已有 docs、CI，以及主要目录、应用入口和测试。识别产品意图、系统边界、依赖方向、稳定公共接口、数据/安全/权限边界、明确不变量和重要技术取舍；忽略依赖、生成物、大文件、秘密值以及能从代码直接获得的局部实现细节。
3. 先形成文档计划，再写文件：在 repository.yaml 中保留 shared、overview 与 constitution 固定入口，并只为明确的应用或服务边界增加 scope。对每条候选内容使用同一个判断：未来 Agent 不知道它时，是否可能写出局部正确但整体违背设计意图的实现；不会则不写入 .alignyard/。
4. 完善 ${ay} init 生成的 doc.shared.constitution：只记录有仓库证据或用户已确认的全局意图、不可随意改变的架构边界、关键不确定性确认规则与已有机器检查。运行 ${ay} new doc overview --scope shared --title "仓库概览"。overview 只负责仓库全貌和导航；只有会独立演进且确实影响设计方向的主题才拆成独立 Docs。
5. Specs 只描述已有明确目标但尚未完成的变更；ADRs 只记录仓库中已有明确依据的长期决策；Plans 只用于已有明确需求的可选技术方案。初始化时不要为了凑数量创建空洞或推测性的 Spec/ADR/Plan。
6. 做一次意图覆盖与精简检查：确认核心意图、架构边界、稳定契约、不变量和长期取舍足以约束后续 Agent，同时删除函数级机制、普通字段流转和与源码重复的内容。不要把 ${ay} validate . 通过当作内容正确或精简。
7. 只修改 .alignyard/。运行 ${ay} validate .，修复全部结构问题，再复查 overview 是否能导航到新增知识。
8. 运行 git add .alignyard && git commit -m "docs: initialize Alignyard knowledge"。如果 Git 身份缺失，使用当前仓库已有的 author 配置；不要改全局配置。
9. 最后确认 git status --short 为空，并总结检查过的证据、生成的 scopes/Docs/Specs/ADRs、主动省略的主题及原因、未决问题和验证结果。用户点击“提交 Review”时，Runner 会重新执行 ${ay} validate .、检查提交并推送工作分支。

语言要求：SKILL.md 可以使用英文；所有 Docs、Specs、ADRs、Plans 的 title、章节标题和叙述正文必须使用简体中文。代码标识符、命令、路径、API 名称和已有产品名保持原样，不要为了翻译而降低准确性。

边界：不要修改业务源代码，不要 push，不要创建或合并 PR/MR，不要修改 ${repository.base_branch}。Review、push、创建与合并请求由平台在人工确认后执行。`;
}

export function knowledgeDesignPrompt(task: PlatformTask): string {
  const repository = editableRepository(task);
  return `你正在执行 Alignyard 知识设计 Task ${task.key}：${task.title}。

原始需求：
${task.description || "以 Task 标题和当前用户在会话中的补充为原始需求。"}

当前 Repository：${repository.name}
工作分支：${repository.work_branch}
基线分支：${repository.base_branch}

本次默认目标不是编码，而是形成经过人类 Review 后可以稳定指导后续实现的最小充分设计包。.alignyard/ 只保存 AI 不能随意重新决定的核心工程意图与架构约束；函数级机制和普通实现细节继续留在代码、类型和测试中。请完整阅读 .alignyard/skills/alignyard-knowledge/SKILL.md，并按以下顺序自主推进：
1. 阅读 repository.yaml 的 overview 与 constitution 固定入口，再按 Task 目标、scope 和 relations 读取相关 Docs、Specs、ADRs 与已有 Plans。检查仓库证据，但不要修改业务源码。
2. 判断本次变化真正需要新增或更新哪些文档：明确的新能力或边界变化通常需要一份精简 Spec；小修正、纯文档整理或已有 Spec 已完整覆盖时，可以只更新现有文档。不要为了流程形式强制创建主 Spec。原始飞书或其他链接只能放入 sources 供追溯，后续以确认后的仓库文档为准。
3. 仅在存在长期技术取舍及明显替代方案时新增或更新 ADR。根据复杂度判断是否需要 Plan；Plan 是可选的，但一旦创建，governing 必须包含 constitution，并只引用真正约束本次实现的 Docs、Specs、ADRs。新产品行为或边界变化通常应有 Spec；现有知识已经明确意图时不强制创建。Plan 还需明确修改范围、保持不变、实施步骤、验证方案和文档更新。
4. 如果缺少的信息可能改变产品意图、公共接口、架构边界、兼容性或修改范围，直接在当前会话向用户提问，等待回答后继续；不要自行推断，也不要创建额外的决策记录实体。把确认结论直接写入最终 Spec、ADR、Plan 或 Docs。
5. 仅当需求会改变长期有效的架构事实、边界或稳定接口时，才在正常 .alignyard/docs/ 路径起草目标状态 Docs。当前 Task 分支就是待发布状态，不创建 temp-docs 或其他副本；默认分支上的 Docs 仍代表当前事实。
6. 复查设计包是否最小充分、一致、可直接交给 Codex/Claude 实现：保留会阻止整体设计漂移的内容，删除可由源码直接推导的细节，并检查 governing、应该修改和保持不变的范围、未决问题与验收标准。
7. 运行 ay validate .，修复全部结构问题。只提交本次必要的 .alignyard/ 变更，确保 git status --short 为空。用户点击“提交 Review”时，Runner 会重新校验当前 worktree、检查提交并推送工作分支；不要向 Platform 上传工程知识。

完成后总结新增或更新的权威文档、适用约束、主动省略的实现细节、已经向用户确认的关键问题、仍存在的非阻塞问题和验证结果。若改变了任何 governing 文档，必须点名说明改变的核心意图及原因，然后等待用户在 Alignyard 提交人工 Review。

边界：除非用户明确扩展当前 Task 要求实现，否则不要修改业务源码、不要 push、不要创建或合并 PR/MR。Review、push 与设计基线记录由 Alignyard 在人工确认后完成。`;
}

export function taskReviewPrompt(task: PlatformTask): string {
  const repository = editableRepository(task);
  return `你正在 Alignyard 的人工 Review 工作区中，辅助 reviewer 审核 Task ${task.key}：${task.title}。

当前工作分支：${repository.work_branch}
对比基线：${repository.base_branch}（${repository.base_commit || "以平台记录为准"}）

Platform 只保存 Task 流转元数据，不保存工程知识、摘要或 diff。当前 reviewer worktree 是审核内容的唯一工作副本；请先读取其中的 .alignyard/，并使用 git diff ${repository.base_commit || repository.base_branch}...HEAD -- .alignyard 查看完整变化，然后等待 reviewer 提问或下达具体指令，不要自行展开完整审查。

你可以按需：
- 解释 Docs、Specs、ADRs、Plans 的内容及变更原因；
- 查找仓库证据，核对文档与实际工程是否一致；
- 展示和解释 diff、文件关系与潜在问题；
- 按 reviewer 要求运行检查；
- 在 reviewer 明确要求后修改、提交并 push 当前工作分支。

不要自行给出“审核通过”结论，不要替人操作 Review、PR/MR 或合并，也不要在没有明确指令时修改或 push。

如果 reviewer 明确要求你修改，请运行 ay validate .、提交变更、确保 git status --short 为空，并使用 git push origin HEAD:${repository.work_branch} 将提交推送到原工作分支。回答时优先提供可核验的文件、diff 和代码证据，支持 reviewer 进行多轮判断。`;
}

export function repositoryRevisionPrompt(task: PlatformTask): string {
  const repository = editableRepository(task);
  const feedback = task.review?.feedback || "请根据 reviewer 的要求继续完善当前工程知识。";
  return `Alignyard Task ${task.key} 已被 reviewer 要求修改。

Review 反馈：
${feedback}

请基于当前工作分支 ${repository.work_branch || "已有工作分支"} 和现有 .alignyard/ 继续处理，不要重新执行 ay init，也不要重复首次初始化流程。开始修改前先执行 git fetch origin，并检查 origin/${repository.work_branch || "<工作分支>"} 是否包含 reviewer 已推送的提交；如有，先安全地 fast-forward 或 rebase，不能覆盖远端提交。

请检查反馈涉及的 Docs、Specs、ADRs、Plans、约束引用和仓库证据，完成必要修改并提交。遇到可能改变产品意图、公共接口、架构边界、兼容性或修改范围的关键不确定性时，直接在当前会话询问用户，不要自行推断。不要自行 push、提交 Review、创建或合并 PR/MR；这些操作由用户在 Alignyard 页面确认。完成后总结修改内容和验证结果，然后等待用户主动提交 Review。`;
}

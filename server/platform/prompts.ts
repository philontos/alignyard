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
  platformUrl: string;
}): string {
  const repository = editableRepository(input.task);
  const tsx = input.root ? path.join(input.root, "node_modules", ".bin", "tsx") : "";
  const entry = input.root ? path.join(input.root, "server", "ay.ts") : "";
  const ay = input.ayCommand || `${shellArg(tsx)} ${shellArg(entry)}`;
  return `你正在执行 Alignyard 平台的 Repository 初始化 Task ${input.task.key}。

目标：只在当前 Task worktree 中为 ${repository.name} 建立准确、小而完整、可评审的版本化工程知识。初始化不是“创建一份 overview 并通过校验”，而是让后续成员能够理解仓库边界、关键入口和稳定协作方式。

请自主完成以下流程，不要等待用户逐条确认：
1. 运行 ${ay} init .，然后完整阅读生成的 .alignyard/skills/alignyard-knowledge/SKILL.md；后续步骤以该 Skill 为工作规范。
2. 盘点证据：阅读仓库 README、package/workspace metadata、已有 docs、CI，以及主要目录、应用入口和测试。识别系统边界、主要数据流、稳定 CLI/API/配置、开发与发布方式、仓库专属协议和目录规范；忽略依赖、生成物、大文件和秘密值。
3. 先形成文档计划，再写文件：在 repository.yaml 中保留 shared，并只为明确的应用或服务边界增加 scope。逐项判断“架构与边界、开发/构建/测试/发布、CLI/API/配置契约、仓库专属协议与维护流程、各 scope 概览”是否适用于当前仓库。
4. 运行 ${ay} new doc overview --scope shared --title "仓库概览"。overview 只负责仓库全貌和导航；有充分代码或文档证据、且会独立演进的主题，必须通过 ${ay} new doc <slug> --scope <scope> --title <中文标题> 拆成独立 Docs。拥有多条稳定命令或专属协议的仓库，通常应为这些内容建立独立 Doc，不要全部塞入 overview。
5. Specs 只描述已有明确目标但尚未完成的变更；ADRs 只记录仓库中已有明确依据的长期决策。不要为了凑数量创建空洞或推测性的 Spec/ADR。
6. 做一次内容完整性检查：每个有效 scope 和每个适用的长期主题，都必须对应一个 Doc、明确由 overview 覆盖，或在最终总结中给出基于证据的省略原因。不要把 ${ay} validate . 通过当作内容已经完整。
7. 只修改 .alignyard/。运行 ${ay} validate .，修复全部结构问题，再复查 overview 是否能导航到新增知识。
8. 运行 git add .alignyard && git commit -m "docs: initialize Alignyard knowledge"。如果 Git 身份缺失，使用当前仓库已有的 author 配置；不要改全局配置。
9. 提交后运行 ${ay} sync . --platform ${shellArg(input.platformUrl)} --task ${input.task.key} --repository-id ${repository.id} --base-commit "$(git merge-base HEAD ${shellArg(`origin/${repository.base_branch}`)})"。
10. 最后确认 git status --short 为空，并总结检查过的证据、生成的 scopes/Docs/Specs/ADRs、主动省略的主题及原因、未决问题和验证结果。

语言要求：SKILL.md 可以使用英文；所有 Docs、Specs、ADRs 的 title、章节标题和叙述正文必须使用简体中文。代码标识符、命令、路径、API 名称和已有产品名保持原样，不要为了翻译而降低准确性。

边界：不要修改业务源代码，不要 push，不要创建或合并 PR/MR，不要修改 ${repository.base_branch}。Review、push、创建与合并请求由平台在人工确认后执行。`;
}

export function taskReviewPrompt(task: PlatformTask, options: { syncChanges?: boolean } = {}): string {
  const repository = editableRepository(task);
  return `你正在 Alignyard 的人工 Review 工作区中，辅助 reviewer 审核 Task ${task.key}：${task.title}。

当前工作分支：${repository.work_branch}
对比基线：${repository.base_branch}（${repository.base_commit || "以平台记录为准"}）

你是 reviewer 的辅助 Agent，不是 Review 决策者。请先了解 Task、工程知识和当前 diff，然后等待 reviewer 提问或下达具体指令，不要自行展开完整审查。

你可以按需：
- 解释 Docs、Specs、ADRs 的内容及变更原因；
- 查找仓库证据，核对文档与实际工程是否一致；
- 展示和解释 diff、文件关系与潜在问题；
- 按 reviewer 要求运行检查；
- 在 reviewer 明确要求后修改、提交并 push 当前工作分支。

不要自行给出“审核通过”结论，不要替人操作 Review、PR/MR 或合并，也不要在没有明确指令时修改或 push。

如果 reviewer 明确要求你修改，请在结束前确保 git status --short 为空，并使用 git push origin HEAD:${repository.work_branch} 将提交推送到原工作分支。${options.syncChanges ? "推送后运行 ay validate . 和 ay sync .，确保 Platform 记录的 commit 与修改后的 HEAD 一致。" : ""}回答时优先提供可核验的文件、diff 和代码证据，支持 reviewer 进行多轮判断。`;
}

export function repositoryRevisionPrompt(task: PlatformTask): string {
  const repository = editableRepository(task);
  const feedback = task.review?.feedback || "请根据 reviewer 的要求继续完善当前工程知识。";
  return `Alignyard Task ${task.key} 已被 reviewer 要求修改。

Review 反馈：
${feedback}

请基于当前工作分支 ${repository.work_branch || "已有工作分支"} 和现有 .alignyard/ 继续处理，不要重新执行 ay init，也不要重复首次初始化流程。开始修改前先执行 git fetch origin，并检查 origin/${repository.work_branch || "<工作分支>"} 是否包含 reviewer 已推送的提交；如有，先安全地 fast-forward 或 rebase，不能覆盖远端提交。

请检查反馈涉及的 Docs、Specs、ADRs 和仓库证据，完成必要修改并提交。不要自行 push、提交 Review、创建或合并 PR/MR；这些操作由用户在 Alignyard 页面确认。完成后总结修改内容和验证结果，然后等待用户主动提交 Review。`;
}

import path from "node:path";
import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import type { AgentKind } from "../session/agent.js";
import { createRepoTask, type RepoTaskEnv } from "../task/createtask.js";
import {
  decidePlatformTaskReview,
  deletePlatformTask,
  getPlatformTask,
  linkPlatformTaskRuntime,
  markPlatformTaskReviewStarted,
  markPlatformPullRequestMerged,
  recordPlatformPullRequest,
  recordPlatformTaskPush,
  setPlatformTaskWorkflowError,
  submitPlatformTaskReview,
  updatePlatformTaskCommits,
  updatePlatformTaskExecutionStatus,
  type PlatformRepository,
  type PlatformTask,
} from "./catalog.js";
import {
  changeRequestLabel,
  closeChangeRequest,
  createChangeRequest,
  mergeChangeRequest,
  resolveForge,
  type ChangeRequestInput,
} from "./forge.js";

type DB = Database.Database;

export class PlatformWorkflowError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlatformWorkflowError";
  }
}

function errorMessage(error: unknown): string {
  return String((error as any)?.stderr || (error as any)?.message || error).trim();
}

export interface PlatformWorkflowEnv {
  db: DB;
  root: string;
  runner: Runner;
  runtimeEnv: RepoTaskEnv;
  getLocalRepository(gitUrl: string): Repo | undefined;
  getRuntimeTask(id: number): Task | undefined;
  stopRuntimeTask(id: number): Promise<void>;
  cleanupRuntimeTask(id: number): Promise<void>;
  deleteRuntimeTask(id: number): Promise<void>;
  refreshRepository(id: number): Promise<PlatformRepository>;
}

type InitializationStartResult = { task: PlatformTask; runtime: Task; created: boolean };
type InitializationMergeResult = { task: PlatformTask; repository: PlatformRepository; cleanup_warning?: string };
const initializationStarts = new WeakMap<object, Map<string, Promise<InitializationStartResult>>>();
const changeRequestStarts = new WeakMap<object, Map<string, Promise<PlatformTask>>>();
const changeRequestMerges = new WeakMap<object, Map<string, Promise<InitializationMergeResult>>>();
const reviewAgentStarts = new WeakMap<object, Map<string, Promise<InitializationStartResult>>>();

function initTask(env: PlatformWorkflowEnv, key: string): PlatformTask {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.task_type !== "repository_init") throw new PlatformWorkflowError(409, "当前 Task 不是 Repository 初始化任务");
  return task;
}

function editableRepository(task: PlatformTask) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) throw new PlatformWorkflowError(409, "Task 缺少 editable Repository");
  return repository;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function repositoryInitializationPrompt(input: {
  root: string;
  task: PlatformTask;
  platformUrl: string;
}): string {
  const repository = editableRepository(input.task);
  const tsx = path.join(input.root, "node_modules", ".bin", "tsx");
  const entry = path.join(input.root, "server", "ay.ts");
  const ay = `${shellArg(tsx)} ${shellArg(entry)}`;
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

export function taskReviewPrompt(task: PlatformTask): string {
  const repository = editableRepository(task);
  return `你正在 Alignyard 中 Review Task ${task.key}：${task.title}。

当前分支是提交人已经推送的 ${repository.work_branch}，对比基线是 ${repository.base_branch}（${repository.base_commit || "以平台记录为准"}）。

请先阅读 Task 描述、工程知识和完整 diff，再检查实现正确性、边界条件、测试、文档与安全风险。你可以按需要直接修改当前 worktree、提交并 push 到同一个工作分支；GitHub/GitLab 权限是唯一权限边界，Alignyard 不限制 reviewer 修改分支。

如果做了修改，请在结束前确保 git status --short 为空，并将提交 push 到 origin/${repository.work_branch}。不要替人点击“要求修改”“审核通过”、创建或合并 PR/MR；这些决定由 reviewer 在 Alignyard 页面人工确认。最后清晰总结发现、修改、验证结果和仍需人工判断的问题。`;
}

async function performRepositoryInitializationStart(
  env: PlatformWorkflowEnv,
  key: string,
  platformUrl: string,
  agent: AgentKind = "codex",
): Promise<InitializationStartResult> {
  let task = initTask(env, key);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态的初始化 Task 可以启动 Agent");
  const repository = editableRepository(task);
  setPlatformTaskWorkflowError(env.db, key, null);
  try {
    if (task.runtime_task_id) {
      const existing = env.getRuntimeTask(task.runtime_task_id);
      if (existing?.worktree_path && await env.runner.exists(existing.worktree_path).catch(() => false)) {
        return { task, runtime: existing, created: false };
      }
    }

    const local = env.getLocalRepository(repository.git_url);
    if (!local?.mirror_path || local.status !== "ready") {
      throw new PlatformWorkflowError(409, "本机 Repository 尚未就绪，无法创建初始化 worktree");
    }

    const prompt = repositoryInitializationPrompt({ root: env.root, task, platformUrl });
    const result = await createRepoTask(
      env.runtimeEnv,
      { id: local.id, name: local.name, mirror_path: local.mirror_path },
      {
        baseBranch: repository.remote_pushed_at && repository.work_branch
          ? repository.work_branch
          : repository.base_branch,
        workBranch: repository.work_branch,
        title: `[${task.key}] Initialize ${repository.name}`,
        prompt,
        agent,
        automated: true,
        env: {
          AY_PLATFORM_URL: platformUrl,
          AY_TASK_KEY: task.key,
          AY_REPOSITORY_ID: String(repository.id),
          ...(process.env.ALIGNYARD_API_TOKEN
            ? { AY_PLATFORM_TOKEN: process.env.ALIGNYARD_API_TOKEN }
            : {}),
        },
      },
    );
    if (!result.ok && result.error === "invalidReference") {
      throw new PlatformWorkflowError(400, result.message);
    }
    const runtime = env.getRuntimeTask(result.id);
    if (runtime) {
      const originalBase = repository.base_commit || runtime.base_commit;
      if (originalBase && originalBase !== runtime.base_commit) {
        env.db.prepare("UPDATE tasks SET base_commit=? WHERE id=?").run(originalBase, runtime.id);
        await env.runtimeEnv.writeManifest(runtime.id);
        runtime.base_commit = originalBase;
      }
      task = linkPlatformTaskRuntime(env.db, key, {
        id: runtime.id,
        work_branch: runtime.work_branch || repository.work_branch || "",
        base_commit: originalBase,
        actor: task.owner,
        role: "author",
        agent: runtime.agent,
      }) || task;
    }
    if (!result.ok || !runtime) {
      const message = result.ok ? "runtime Task 创建后未找到" : result.message;
      throw new PlatformWorkflowError(500, `初始化 Agent 启动失败：${message}`);
    }
    return { task, runtime, created: true };
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

/** Collapse concurrent clicks for the same platform Task onto one worktree
 * creation. The stable init branch makes duplicate dispatch unsafe until the
 * first runtime row has been linked back to the platform Task. */
export async function startRepositoryInitialization(
  env: PlatformWorkflowEnv,
  key: string,
  platformUrl: string,
  agent: AgentKind = "codex",
): Promise<InitializationStartResult> {
  let starts = initializationStarts.get(env.db);
  if (!starts) {
    starts = new Map();
    initializationStarts.set(env.db, starts);
  }
  const normalizedKey = key.toUpperCase();
  const active = starts.get(normalizedKey);
  if (active) {
    const result = await active;
    return { ...result, task: getPlatformTask(env.db, normalizedKey) || result.task, created: false };
  }

  const operation = performRepositoryInitializationStart(env, normalizedKey, platformUrl, agent);
  starts.set(normalizedKey, operation);
  try {
    return await operation;
  } finally {
    if (starts.get(normalizedKey) === operation) starts.delete(normalizedKey);
  }
}

async function repositoryHead(env: PlatformWorkflowEnv, task: PlatformTask): Promise<{
  runtime: Task;
  repository: ReturnType<typeof editableRepository>;
  head: string;
}> {
  const repository = editableRepository(task);
  if (!task.runtime_task_id) throw new PlatformWorkflowError(409, "Task Agent 尚未启动");
  const runtime = env.getRuntimeTask(task.runtime_task_id);
  if (!runtime?.worktree_path || !(await env.runner.exists(runtime.worktree_path))) {
    throw new PlatformWorkflowError(409, "Task worktree 不存在");
  }
  const dirty = (await env.runner.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: runtime.worktree_path,
  })).trim();
  if (dirty) throw new PlatformWorkflowError(409, "worktree 仍有未提交变更，请让 Agent 完成提交和 sync");
  const head = (await env.runner.exec("git", ["rev-parse", "HEAD"], { cwd: runtime.worktree_path })).trim();
  if (!head || head === runtime.base_commit) throw new PlatformWorkflowError(409, "Task 尚未产生可评审的提交");
  if (repository.head_commit !== head) {
    throw new PlatformWorkflowError(409, "最新提交尚未 sync，请让 Agent 重新执行 ay sync");
  }
  return { runtime, repository, head };
}

export async function submitPlatformTaskForReview(
  env: PlatformWorkflowEnv,
  key: string,
  input: {
    reviewer: unknown;
    reviewer_user_id?: unknown;
    submitted_by: unknown;
    submitted_by_user_id?: unknown;
  },
): Promise<PlatformTask> {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态可以提交 Review");
  const reviewer = typeof input.reviewer === "string" ? input.reviewer.trim() : "";
  const submittedBy = typeof input.submitted_by === "string" ? input.submitted_by.trim() : "";
  if (!reviewer || !submittedBy) throw new PlatformWorkflowError(400, "Reviewer 和提交人不能为空");
  try {
    if (task.task_type === "repository_init") {
      const editable = editableRepository(task);
      const hasSharedOverview = task.artifacts.some(
        (artifact) => artifact.kind === "doc" && artifact.path === ".alignyard/docs/shared/overview.md",
      );
      if (editable.manifest_status !== "valid" || !hasSharedOverview) {
        throw new PlatformWorkflowError(
          409,
          "初始化 Task 需要先完成 ay validate、ay sync，并提供 .alignyard/docs/shared/overview.md",
        );
      }
    }
    const { runtime, head } = await repositoryHead(env, task);
    const headBranch = task.repositories.find((item) => item.mode === "editable")?.work_branch || runtime.work_branch;
    if (!headBranch) throw new PlatformWorkflowError(409, "Task 工作分支不存在");
    await env.runner.exec("git", ["push", "--set-upstream", "origin", headBranch], {
      cwd: runtime.worktree_path!,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    updatePlatformTaskCommits(env.db, key, { base_commit: runtime.base_commit, head_commit: head });
    recordPlatformTaskPush(env.db, key, head);
    await env.stopRuntimeTask(runtime.id);
    updatePlatformTaskExecutionStatus(env.db, key, runtime.id, "stopped");
    const updated = submitPlatformTaskReview(env.db, key, {
      reviewer,
      reviewer_user_id: input.reviewer_user_id,
      submitted_by: submittedBy,
      submitted_by_user_id: input.submitted_by_user_id,
    });
    if (!updated) throw new PlatformWorkflowError(404, "Task 不存在");
    setPlatformTaskWorkflowError(env.db, key, null);
    return getPlatformTask(env.db, key) || updated;
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

async function performReviewAgentStart(
  env: PlatformWorkflowEnv,
  key: string,
  agent: AgentKind,
): Promise<InitializationStartResult> {
  let task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.status !== "review" || !task.review || !["pending", "in_progress"].includes(task.review.status)) {
    throw new PlatformWorkflowError(409, "Task 当前不在待 Review 状态");
  }
  const repository = editableRepository(task);
  if (!repository.remote_pushed_at || !repository.work_branch) {
    throw new PlatformWorkflowError(409, "Review 分支尚未推送到远端");
  }

  const currentRuntimeTaskId = task.runtime_task_id;
  const current = currentRuntimeTaskId ? env.getRuntimeTask(currentRuntimeTaskId) : undefined;
  const currentExecution = task.executions.find((item) => item.runtime_task_id === currentRuntimeTaskId);
  if (current?.worktree_path && currentExecution?.role === "reviewer") {
    return { task, runtime: current, created: false };
  }

  setPlatformTaskWorkflowError(env.db, key, null);
  try {
    if (current) {
      await env.cleanupRuntimeTask(current.id);
      updatePlatformTaskExecutionStatus(env.db, key, current.id, "cleaned");
    }
    const local = env.getLocalRepository(repository.git_url);
    if (!local?.mirror_path || local.status !== "ready") {
      throw new PlatformWorkflowError(409, "本机 Repository 尚未就绪，无法拉取 Review worktree");
    }
    const result = await createRepoTask(
      env.runtimeEnv,
      { id: local.id, name: local.name, mirror_path: local.mirror_path },
      {
        baseBranch: repository.work_branch,
        workBranch: repository.work_branch,
        title: `[${task.key}] Review ${repository.name}`,
        prompt: taskReviewPrompt(task),
        agent,
        automated: false,
        env: process.env.ALIGNYARD_API_TOKEN
          ? { AY_PLATFORM_TOKEN: process.env.ALIGNYARD_API_TOKEN }
          : undefined,
      },
    );
    if (!result.ok) {
      throw new PlatformWorkflowError(500, `Review Agent 启动失败：${result.message}`);
    }
    const runtime = env.getRuntimeTask(result.id);
    if (!runtime) throw new PlatformWorkflowError(500, "Review runtime Task 创建后未找到");
    if (repository.base_commit) {
      env.db.prepare("UPDATE tasks SET base_commit=? WHERE id=?").run(repository.base_commit, runtime.id);
      await env.runtimeEnv.writeManifest(runtime.id);
      runtime.base_commit = repository.base_commit;
    }
    task = linkPlatformTaskRuntime(env.db, key, {
      id: runtime.id,
      work_branch: repository.work_branch,
      // Keep the Task's original review baseline; starting from the pushed head
      // must not make the review diff appear empty.
      base_commit: repository.base_commit,
      actor: task.review.reviewer,
      role: "reviewer",
      agent: runtime.agent,
    }) || task;
    task = markPlatformTaskReviewStarted(env.db, key) || task;
    return { task, runtime, created: true };
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

export async function startPlatformTaskReviewAgent(
  env: PlatformWorkflowEnv,
  key: string,
  agent: AgentKind = "codex",
): Promise<InitializationStartResult> {
  let starts = reviewAgentStarts.get(env.db);
  if (!starts) {
    starts = new Map();
    reviewAgentStarts.set(env.db, starts);
  }
  const normalizedKey = key.toUpperCase();
  const active = starts.get(normalizedKey);
  if (active) return active;
  const operation = performReviewAgentStart(env, normalizedKey, agent);
  starts.set(normalizedKey, operation);
  try {
    return await operation;
  } finally {
    if (starts.get(normalizedKey) === operation) starts.delete(normalizedKey);
  }
}

export async function decidePlatformTaskReviewWorkflow(
  env: PlatformWorkflowEnv,
  key: string,
  decision: "approved" | "changes_requested",
): Promise<PlatformTask> {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.status !== "review" || !task.review) throw new PlatformWorkflowError(409, "Task 当前不在 Review");
  const runtime = task.runtime_task_id ? env.getRuntimeTask(task.runtime_task_id) : undefined;
  try {
    if (runtime) {
      if (decision === "approved") {
        await env.stopRuntimeTask(runtime.id);
        updatePlatformTaskExecutionStatus(env.db, key, runtime.id, "stopped");
      } else {
        await env.cleanupRuntimeTask(runtime.id);
        updatePlatformTaskExecutionStatus(env.db, key, runtime.id, "cleaned");
      }
    }
    const updated = decidePlatformTaskReview(env.db, key, decision);
    if (!updated) throw new PlatformWorkflowError(404, "Task 不存在");
    setPlatformTaskWorkflowError(env.db, key, null);
    return getPlatformTask(env.db, key) || updated;
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

async function performCreateRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  let task = initTask(env, key);
  if (task.status !== "approved") {
    throw new PlatformWorkflowError(409, "Task 需要先通过 Review");
  }
  let requestLabel = "合并请求";
  try {
    const repository = editableRepository(task);
    const runtime = task.runtime_task_id ? env.getRuntimeTask(task.runtime_task_id) : undefined;
    const local = env.getLocalRepository(repository.git_url);
    const cwd = runtime?.worktree_path && await env.runner.exists(runtime.worktree_path)
      ? runtime.worktree_path
      : local?.mirror_path && await env.runner.exists(local.mirror_path) ? local.mirror_path : null;
    if (!cwd) throw new PlatformWorkflowError(409, "本机 Repository 不存在，无法创建合并请求");
    const headBranch = repository.work_branch || runtime?.work_branch;
    if (!headBranch) throw new PlatformWorkflowError(409, "Task 工作分支不存在");
    const forge = await resolveForge({ runner: env.runner, cwd, gitUrl: repository.git_url });
    requestLabel = changeRequestLabel(forge);
    if (task.pr_state === "merged" || task.pr_state === "closed") {
      throw new PlatformWorkflowError(409, `${requestLabel} 已${task.pr_state === "merged" ? "合并" : "关闭"}`);
    }
    const forgeInput: ChangeRequestInput = {
      runner: env.runner,
      cwd,
      gitUrl: repository.git_url,
      baseBranch: repository.base_branch,
      headBranch,
    };
    const body = [
      `Alignyard initialization for ${repository.name}.`,
      "",
      `Platform Task: ${task.key}`,
      `Knowledge artifacts: ${task.artifacts.length}`,
      "",
      "Prepared by the Repository Init workflow after local validation and platform sync.",
    ].join("\n");
    const changeRequest = await createChangeRequest(forge, {
      ...forgeInput,
      title: `[${task.key}] Initialize Alignyard knowledge`,
      body,
    });
    recordPlatformPullRequest(env.db, key, changeRequest);
    task = getPlatformTask(env.db, key) || task;
    return task;
  } catch (error: any) {
    const message = errorMessage(error);
    setPlatformTaskWorkflowError(env.db, key, message);
    if (error instanceof PlatformWorkflowError) throw error;
    throw new PlatformWorkflowError(502, `创建 ${requestLabel} 失败：${message}`);
  }
}

/** Creating a remote PR/MR and recording it locally cannot be one transaction.
 * Collapse concurrent clicks per Task; the forge adapter separately reconciles
 * an already-created request so retries after process/network failure are safe. */
export async function createRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  let operations = changeRequestStarts.get(env.db);
  if (!operations) {
    operations = new Map();
    changeRequestStarts.set(env.db, operations);
  }
  const normalizedKey = key.toUpperCase();
  const active = operations.get(normalizedKey);
  if (active) return active;
  const operation = performCreateRepositoryInitializationPullRequest(env, normalizedKey);
  operations.set(normalizedKey, operation);
  try {
    return await operation;
  } finally {
    if (operations.get(normalizedKey) === operation) operations.delete(normalizedKey);
  }
}

async function performMergeRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<InitializationMergeResult> {
  let task = initTask(env, key);
  if (task.status !== "approved" || !task.pr_number) {
    throw new PlatformWorkflowError(409, "需要先批准 Review 并创建合并请求");
  }
  const repository = editableRepository(task);
  const runtime = task.runtime_task_id ? env.getRuntimeTask(task.runtime_task_id) : undefined;
  let requestLabel = changeRequestLabel(repository.forge_kind);

  try {
    if (task.pr_state !== "merged") {
      const local = env.getLocalRepository(repository.git_url);
      const cwd = runtime?.worktree_path && await env.runner.exists(runtime.worktree_path)
        ? runtime.worktree_path
        : local?.mirror_path && await env.runner.exists(local.mirror_path) ? local.mirror_path : null;
      if (!cwd) throw new PlatformWorkflowError(409, "本机 Repository 不存在，无法合并请求");
      const forge = await resolveForge({ runner: env.runner, cwd, gitUrl: repository.git_url });
      requestLabel = changeRequestLabel(forge);
      const changeRequest = await mergeChangeRequest(forge, {
        runner: env.runner,
        cwd,
        gitUrl: repository.git_url,
        baseBranch: repository.base_branch,
        headBranch: repository.work_branch || runtime?.work_branch || "",
      }, task.pr_number);
      if (changeRequest.state !== "merged") throw new PlatformWorkflowError(409, `${requestLabel} 尚未合并`);
      recordPlatformPullRequest(env.db, key, changeRequest);
      markPlatformPullRequestMerged(env.db, key);
      task = getPlatformTask(env.db, key) || task;
    }

    const refreshed = await env.refreshRepository(repository.id);
    if (refreshed.protocol_state !== "ready") {
      throw new PlatformWorkflowError(409, refreshed.protocol_error || `${requestLabel} 已合并，但默认分支尚未通过初始化检查`);
    }
    setPlatformTaskWorkflowError(env.db, key, null);

    let cleanupWarning: string | undefined;
    if (runtime?.worktree_path && await env.runner.exists(runtime.worktree_path).catch(() => false)) {
      await env.runner.exec("git", ["push", "origin", "--delete", repository.work_branch || runtime.work_branch], {
        cwd: runtime.worktree_path,
        env: { GIT_TERMINAL_PROMPT: "0" },
      }).catch(() => {});
      try { await env.cleanupRuntimeTask(runtime.id); } catch (error: any) {
        cleanupWarning = errorMessage(error);
        setPlatformTaskWorkflowError(env.db, key, `${requestLabel} 已合并，但清理 worktree 失败：${cleanupWarning}`);
      }
    }
    return { task: getPlatformTask(env.db, key) || task, repository: refreshed, cleanup_warning: cleanupWarning };
  } catch (error: any) {
    const message = errorMessage(error);
    setPlatformTaskWorkflowError(env.db, key, message);
    if (error instanceof PlatformWorkflowError) throw error;
    throw new PlatformWorkflowError(502, `合并 ${requestLabel} 失败：${message}`);
  }
}

/** Merge clicks have the same remote-side-effect boundary as creation. Collapse
 * concurrent calls; mergeChangeRequest also reconciles a forge-side success
 * before surfacing any local CLI error. */
export async function mergeRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<InitializationMergeResult> {
  let operations = changeRequestMerges.get(env.db);
  if (!operations) {
    operations = new Map();
    changeRequestMerges.set(env.db, operations);
  }
  const normalizedKey = key.toUpperCase();
  const active = operations.get(normalizedKey);
  if (active) return active;
  const operation = performMergeRepositoryInitializationPullRequest(env, normalizedKey);
  operations.set(normalizedKey, operation);
  try {
    return await operation;
  } finally {
    if (operations.get(normalizedKey) === operation) operations.delete(normalizedKey);
  }
}

export async function deletePlatformTaskWithResources(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  let task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");

  try {
    const runtime = task.runtime_task_id ? env.getRuntimeTask(task.runtime_task_id) : undefined;
    if (task.pr_state === "open") {
      if (!task.pr_number) throw new PlatformWorkflowError(409, "Task 的合并请求编号缺失，无法安全删除");
      const repository = editableRepository(task);
      const local = env.getLocalRepository(repository.git_url);
      const cwd = runtime?.worktree_path && await env.runner.exists(runtime.worktree_path)
        ? runtime.worktree_path
        : local?.mirror_path && await env.runner.exists(local.mirror_path) ? local.mirror_path : null;
      if (!cwd) throw new PlatformWorkflowError(409, "本机 Repository 不存在，无法关闭打开的合并请求");
      const headBranch = repository.work_branch || runtime?.work_branch;
      if (!headBranch) throw new PlatformWorkflowError(409, "Task 的工作分支缺失，无法安全删除");
      const forge = await resolveForge({ runner: env.runner, cwd, gitUrl: repository.git_url });
      const closed = await closeChangeRequest(forge, {
        runner: env.runner,
        cwd,
        gitUrl: repository.git_url,
        baseBranch: repository.base_branch,
        headBranch,
      }, task.pr_number);
      recordPlatformPullRequest(env.db, key, closed);
      if (closed.state === "merged") await env.refreshRepository(repository.id);
      task = getPlatformTask(env.db, key) || task;
    }

    const runtimeIds = [...new Set([
      ...task.executions.map((execution) => execution.runtime_task_id),
      ...(task.runtime_task_id ? [task.runtime_task_id] : []),
    ])];
    for (const runtimeId of runtimeIds) {
      const executionRuntime = env.getRuntimeTask(runtimeId);
      if (!executionRuntime) continue;
      // Cleanup is responsible for killing the exact tmux/Agent session as well
      // as removing worktrees. It must run even when the worktree has already
      // disappeared; otherwise a detached Codex/Claude/Kimi process can survive
      // after its durable Task row is deleted.
      await env.cleanupRuntimeTask(runtimeId);
      await env.deleteRuntimeTask(runtimeId);
    }
    const deleted = deletePlatformTask(env.db, key);
    if (!deleted) throw new PlatformWorkflowError(404, "Task 不存在");
    return deleted;
  } catch (error: any) {
    const message = errorMessage(error);
    if (getPlatformTask(env.db, key)) setPlatformTaskWorkflowError(env.db, key, message);
    if (error instanceof PlatformWorkflowError) throw error;
    throw new PlatformWorkflowError(502, `删除 Task 失败：${message}`);
  }
}

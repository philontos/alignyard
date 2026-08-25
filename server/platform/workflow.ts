import path from "node:path";
import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import type { AgentKind } from "../session/agent.js";
import { createRepoTask, type RepoTaskEnv } from "../task/createtask.js";
import {
  deletePlatformTask,
  getPlatformTask,
  linkPlatformTaskRuntime,
  markPlatformPullRequestMerged,
  recordPlatformPullRequest,
  setPlatformTaskWorkflowError,
  updatePlatformTaskCommits,
  updatePlatformTaskStatus,
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

function initTask(env: PlatformWorkflowEnv, key: string): PlatformTask {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.task_type !== "repository_init") throw new PlatformWorkflowError(409, "当前 Task 不是 Repository 初始化任务");
  return task;
}

function editableRepository(task: PlatformTask) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) throw new PlatformWorkflowError(409, "初始化 Task 缺少 editable Repository");
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

目标：只在当前 Task worktree 中为 ${repository.name} 建立准确、最小、可评审的版本化工程知识。

请自主完成以下流程，不要等待用户逐条确认：
1. 运行 ${ay} init .
2. 运行 ${ay} new doc overview --scope shared --title "仓库概览"
3. 阅读仓库的 README、package metadata、主要目录和关键入口；按生成的 alignyard-knowledge Skill 更新 scopes，并把 overview 写成对本仓库真实有用的说明。不要编造事实。
4. 只修改 .alignyard/。运行 ${ay} validate .，修复全部问题。
5. 运行 git add .alignyard && git commit -m "docs: initialize Alignyard knowledge"。如果 Git 身份缺失，使用当前仓库已有的 author 配置；不要改全局配置。
6. 提交后运行 ${ay} sync . --platform ${shellArg(input.platformUrl)} --task ${input.task.key} --repository-id ${repository.id} --base-commit "$(git merge-base HEAD ${shellArg(`origin/${repository.base_branch}`)})"。
7. 最后确认 git status --short 为空，并总结生成的 scopes、Docs、Specs、ADRs 和验证结果。

语言要求：SKILL.md 可以使用英文；所有 Docs、Specs、ADRs 的 title、章节标题和叙述正文必须使用简体中文。代码标识符、命令、路径、API 名称和已有产品名保持原样，不要为了翻译而降低准确性。

边界：不要修改业务源代码，不要 push，不要创建或合并 PR/MR，不要修改 ${repository.base_branch}。Review、push、创建与合并请求由平台在人工确认后执行。`;
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
      if (existing?.worktree_path) return { task, runtime: existing, created: false };
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
        baseBranch: repository.base_branch,
        workBranch: repository.work_branch,
        title: `[${task.key}] Initialize ${repository.name}`,
        prompt,
        agent,
        automated: true,
        env: {
          AY_PLATFORM_URL: platformUrl,
          AY_TASK_KEY: task.key,
          AY_REPOSITORY_ID: String(repository.id),
        },
      },
    );
    if (!result.ok && result.error === "invalidReference") {
      throw new PlatformWorkflowError(400, result.message);
    }
    const runtime = env.getRuntimeTask(result.id);
    if (runtime) {
      task = linkPlatformTaskRuntime(env.db, key, {
        id: runtime.id,
        work_branch: runtime.work_branch || repository.work_branch || "",
        base_commit: runtime.base_commit,
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
  if (!task.runtime_task_id) throw new PlatformWorkflowError(409, "初始化 Agent 尚未启动");
  const runtime = env.getRuntimeTask(task.runtime_task_id);
  if (!runtime?.worktree_path || !(await env.runner.exists(runtime.worktree_path))) {
    throw new PlatformWorkflowError(409, "初始化 worktree 不存在");
  }
  const dirty = (await env.runner.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: runtime.worktree_path,
  })).trim();
  if (dirty) throw new PlatformWorkflowError(409, "worktree 仍有未提交变更，请让 Agent 完成提交和 sync");
  const head = (await env.runner.exec("git", ["rev-parse", "HEAD"], { cwd: runtime.worktree_path })).trim();
  if (!head || head === runtime.base_commit) throw new PlatformWorkflowError(409, "初始化尚未产生可评审的提交");
  if (repository.head_commit !== head) {
    throw new PlatformWorkflowError(409, "最新提交尚未 sync，请让 Agent 重新执行 ay sync");
  }
  return { runtime, repository, head };
}

export async function submitRepositoryInitializationReview(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  const task = initTask(env, key);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态可以提交 Review");
  try {
    const { runtime, head } = await repositoryHead(env, task);
    updatePlatformTaskCommits(env.db, key, { base_commit: runtime.base_commit, head_commit: head });
    await env.stopRuntimeTask(runtime.id);
    const updated = updatePlatformTaskStatus(env.db, key, "review");
    if (!updated) throw new PlatformWorkflowError(404, "Task 不存在");
    setPlatformTaskWorkflowError(env.db, key, null);
    return getPlatformTask(env.db, key) || updated;
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

async function performApproveAndCreateRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  let task = initTask(env, key);
  if (task.status !== "review" && task.status !== "approved") {
    throw new PlatformWorkflowError(409, "Task 需要先进入 Review");
  }
  let requestLabel = "合并请求";
  try {
    const { runtime, repository } = await repositoryHead(env, task);
    const cwd = runtime.worktree_path!;
    const headBranch = repository.work_branch || runtime.work_branch;
    const forge = await resolveForge({ runner: env.runner, cwd, gitUrl: repository.git_url });
    requestLabel = changeRequestLabel(forge);
    if (task.pr_state === "merged" || task.pr_state === "closed") {
      throw new PlatformWorkflowError(409, `${requestLabel} 已${task.pr_state === "merged" ? "合并" : "关闭"}`);
    }
    await env.runner.exec("git", ["push", "--set-upstream", "origin", headBranch], {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
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
    if (task.status === "review") updatePlatformTaskStatus(env.db, key, "approved");
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
export async function approveAndCreateRepositoryInitializationPullRequest(
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
  const operation = performApproveAndCreateRepositoryInitializationPullRequest(env, normalizedKey);
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
      if (!runtime?.worktree_path || !(await env.runner.exists(runtime.worktree_path))) {
        throw new PlatformWorkflowError(409, "初始化 worktree 不存在");
      }
      const cwd = runtime.worktree_path;
      const forge = await resolveForge({ runner: env.runner, cwd, gitUrl: repository.git_url });
      requestLabel = changeRequestLabel(forge);
      const changeRequest = await mergeChangeRequest(forge, {
        runner: env.runner,
        cwd,
        gitUrl: repository.git_url,
        baseBranch: repository.base_branch,
        headBranch: repository.work_branch || runtime.work_branch,
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

    if (runtime) {
      await env.cleanupRuntimeTask(runtime.id);
      await env.deleteRuntimeTask(runtime.id);
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

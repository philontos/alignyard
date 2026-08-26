import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentKind } from "../session/agent.js";
import type { RunnerGateway } from "../runner/gateway.js";
import { createExecutionToken, getRunner, listUserRunners, revokeExecutionTokens } from "../runner/registry.js";
import {
  createPlatformRunnerExecution,
  decidePlatformTaskReview,
  deletePlatformTask,
  getPlatformRunnerExecution,
  getPlatformTask,
  linkPlatformRunnerExecution,
  markPlatformPullRequestMerged,
  markPlatformReviewFeedbackDelivered,
  markPlatformTaskReviewStarted,
  recordPlatformPullRequest,
  recordPlatformTaskPush,
  restoreLatestPlatformAuthorRunnerExecution,
  setPlatformRepositoryProtocolState,
  setPlatformTaskWorkflowError,
  submitPlatformTaskReview,
  updatePlatformRunnerExecution,
  updatePlatformTaskCommits,
  updatePlatformTaskStatus,
  type PlatformRunnerExecution,
  type PlatformTask,
} from "./catalog.js";
import { PlatformWorkflowError } from "./errors.js";
import {
  repositoryInitializationPrompt,
  repositoryRevisionPrompt,
  taskReviewPrompt,
} from "./prompts.js";

type DB = Database.Database;

export interface RunnerWorkflowActor {
  id: number;
  name: string;
}

export interface RunnerWorkflowEnv {
  db: DB;
  gateway: Pick<RunnerGateway, "call" | "isOnline">;
}

interface RuntimeResult {
  runner_task_id: number;
  session?: string | null;
  status?: PlatformRunnerExecution["status"];
  work_branch: string;
  base_commit?: string | null;
  head_commit?: string | null;
  alive?: boolean;
}

interface ChangeRequestResult {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
}

function errorMessage(error: unknown): string {
  return String((error as any)?.message || error).trim();
}

function taskFor(env: RunnerWorkflowEnv, key: string): PlatformTask {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  return task;
}

function editableRepository(task: PlatformTask) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) throw new PlatformWorkflowError(409, "Task 缺少 editable Repository");
  return repository;
}

function requireSupportedRunnerRepositories(task: PlatformTask): void {
  if (task.repositories.length !== 1 || task.repositories[0]?.mode !== "editable") {
    throw new PlatformWorkflowError(409, "当前 Runner workflow 每个 Task 只支持一个 editable Repository");
  }
}

function requireTaskOwner(task: PlatformTask, actor: RunnerWorkflowActor): void {
  const matches = task.owner_user_id != null ? task.owner_user_id === actor.id : task.owner === actor.name;
  if (!matches) throw new PlatformWorkflowError(403, "只有 Task 发起人可以执行此操作");
}

function selectRunner(env: RunnerWorkflowEnv, actor: RunnerWorkflowActor, requestedId?: unknown, agent?: AgentKind) {
  const runners = listUserRunners(env.db, actor.id);
  const requested = typeof requestedId === "string" && requestedId.trim() ? requestedId.trim() : null;
  const runner = requested ? runners.find((item) => item.id === requested) : runners.find((item) => env.gateway.isOnline(item.id));
  if (!runner) throw new PlatformWorkflowError(409, requested ? "Runner 不存在或不属于当前用户" : "当前没有已连接的 Runner");
  if (!env.gateway.isOnline(runner.id)) throw new PlatformWorkflowError(409, "Runner 当前离线，请先在 Mac 上启动 Runner");
  if (runner.os !== "darwin") throw new PlatformWorkflowError(409, "当前版本只支持 macOS Runner");
  if (agent && !(runner.capabilities as any)?.agents?.[agent]) {
    throw new PlatformWorkflowError(409, `Runner 未检测到 ${agent} CLI，请先在本机安装并登录`);
  }
  return runner;
}

function repositoryInput(task: PlatformTask) {
  const repository = editableRepository(task);
  return {
    id: repository.id,
    name: repository.name,
    git_url: repository.git_url,
    default_branch: repository.default_branch,
  };
}

function genericTaskPrompt(task: PlatformTask, platformUrl: string): string {
  const repository = editableRepository(task);
  return `你正在执行 Alignyard Task ${task.key}：${task.title}。

目标：${task.description || "按 Task 标题完成变更，并保持实现、测试和工程知识一致。"}

当前 Repository：${repository.name}
工作分支：${repository.work_branch}
基线分支：${repository.base_branch}

请自主检查仓库说明与 .alignyard/ 工程知识，完成实现、测试和必要的工程知识更新。结束前：
1. 运行与变更相关的检查；
2. 提交全部变更，确保 git status --short 为空；
3. 如修改了 .alignyard/，运行 ay validate .；
4. 运行 ay sync . --platform '${platformUrl.replace(/'/g, `'\\''`)}' --task ${task.key} --repository-id ${repository.id} --base-commit "$(git merge-base HEAD origin/${repository.base_branch})"。

不要 push，不要创建或合并 PR/MR；这些动作由 Alignyard 在人工 Review 后执行。`;
}

function currentRemoteExecution(env: RunnerWorkflowEnv, task: PlatformTask): PlatformRunnerExecution | undefined {
  return task.runner_execution_id ? getPlatformRunnerExecution(env.db, task.runner_execution_id) : undefined;
}

function latestRemoteExecution(env: RunnerWorkflowEnv, task: PlatformTask, role: "author" | "reviewer") {
  return env.db.prepare(
    "SELECT id FROM platform_runner_executions WHERE task_id=? AND role=? ORDER BY created_at DESC,id DESC LIMIT 1",
  ).get(task.id, role) as { id: string } | undefined;
}

function runtimeResult(value: unknown): RuntimeResult {
  const result = value as Partial<RuntimeResult> | null;
  if (!result || !Number.isInteger(result.runner_task_id) || !result.work_branch) {
    throw new PlatformWorkflowError(502, "Runner 返回了无效的执行结果");
  }
  return result as RuntimeResult;
}

function executionEnvironment(task: PlatformTask, platformUrl: string, token: string) {
  const repository = editableRepository(task);
  return {
    AY_PLATFORM_URL: platformUrl,
    AY_PLATFORM_TOKEN: token,
    AY_TASK_KEY: task.key,
    AY_REPOSITORY_ID: String(repository.id),
    ...(repository.base_commit ? { AY_BASE_COMMIT: repository.base_commit } : {}),
  };
}

function freshExecutionEnvironment(
  env: RunnerWorkflowEnv,
  executionId: string,
  task: PlatformTask,
  platformUrl: string,
) {
  revokeExecutionTokens(env.db, executionId);
  const token = createExecutionToken(env.db, executionId, task.key);
  return executionEnvironment(task, platformUrl, token);
}

async function callExecution(
  env: RunnerWorkflowEnv,
  execution: PlatformRunnerExecution,
  method: "execution.status" | "execution.resume" | "execution.stop" | "execution.cleanup" | "execution.message" | "execution.prepare-review",
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  if (!execution.runner_task_id) throw new PlatformWorkflowError(409, "Runner Task 尚未创建");
  return env.gateway.call(execution.runner_id, method, {
    execution_id: execution.id,
    runner_task_id: execution.runner_task_id,
    ...extra,
  });
}

export async function startTaskOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  platformUrl: string,
  actor: RunnerWorkflowActor,
  agent: AgentKind = "codex",
  requestedRunnerId?: unknown,
): Promise<{ task: PlatformTask; runtime_created: boolean }> {
  let task = taskFor(env, key);
  requireSupportedRunnerRepositories(task);
  requireTaskOwner(task, actor);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态的 Task 可以启动 Agent");
  const repository = editableRepository(task);
  const revision = task.review?.status === "changes_requested";
  const latest = latestRemoteExecution(env, task, "author");
  const existing = latest ? getPlatformRunnerExecution(env.db, latest.id) : undefined;
  let tokenExecutionId: string | undefined;

  try {
    if (existing && !existing.runner_task_id && ["queued", "starting"].includes(existing.status)) {
      throw new PlatformWorkflowError(409, "Runner execution 正在启动，请稍候");
    }
    if (existing?.runner_task_id && existing.status !== "cleaned") {
      if (!env.gateway.isOnline(existing.runner_id)) {
        throw new PlatformWorkflowError(409, "此 Task 的原 Runner 当前离线；请恢复该 Runner 后继续，避免丢失本地 worktree");
      }
      if (existing.status === "starting") throw new PlatformWorkflowError(409, "Runner execution 正在启动，请稍候");
      updatePlatformRunnerExecution(env.db, existing.id, { status: "starting", error: null });
      tokenExecutionId = existing.id;
      await callExecution(env, existing, "execution.resume", {
        env: freshExecutionEnvironment(env, existing.id, task, platformUrl),
      });
      env.db.prepare(
        "UPDATE platform_tasks SET runner_execution_id=?,runtime_task_id=NULL,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
      ).run(existing.id, task.id);
      updatePlatformRunnerExecution(env.db, existing.id, { status: "running", error: null });
      if (revision && task.review && !task.review.feedback_delivered_at) {
        await callExecution(env, existing, "execution.message", { message: repositoryRevisionPrompt(task) });
        markPlatformReviewFeedbackDelivered(env.db, key);
      }
      return { task: taskFor(env, key), runtime_created: false };
    }

    const retrying = existing && !existing.runner_task_id && existing.status === "failed";
    const runner = selectRunner(env, actor, retrying ? existing.runner_id : requestedRunnerId, agent);
    const executionId = retrying ? existing.id : `rex_${crypto.randomBytes(12).toString("base64url")}`;
    if (!retrying) {
      const execution = createPlatformRunnerExecution(env.db, key, {
        id: executionId,
        runner_id: runner.id,
        actor: actor.name,
        actor_user_id: actor.id,
        role: "author",
        agent,
      });
      if (!execution) throw new PlatformWorkflowError(404, "Task 不存在");
    }
    updatePlatformRunnerExecution(env.db, executionId, { status: "starting" });
    tokenExecutionId = executionId;
    const executionEnv = freshExecutionEnvironment(env, executionId, task, platformUrl);
    const prompt = revision
      ? repositoryRevisionPrompt(task)
      : task.task_type === "repository_init"
        ? repositoryInitializationPrompt({ task, platformUrl, ayCommand: "ay" })
        : genericTaskPrompt(task, platformUrl);
    const started = runtimeResult(await env.gateway.call(runner.id, "execution.start", {
      execution_id: executionId,
      repository: repositoryInput(task),
      task_key: task.key,
      base_branch: repository.remote_pushed_at && repository.work_branch ? repository.work_branch : repository.base_branch,
      work_branch: repository.work_branch,
      title: `[${task.key}] ${task.title}`,
      prompt,
      agent,
      automated: true,
      env: executionEnv,
    }));
    task = linkPlatformRunnerExecution(env.db, key, executionId, started) || task;
    if (revision) markPlatformReviewFeedbackDelivered(env.db, key);
    return { task: taskFor(env, key), runtime_created: true };
  } catch (error) {
    if (tokenExecutionId) updatePlatformRunnerExecution(
      env.db, tokenExecutionId, { status: "failed", error: errorMessage(error) },
    );
    if (tokenExecutionId) revokeExecutionTokens(env.db, tokenExecutionId);
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

export async function submitTaskForReviewOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
  input: { reviewer: string; reviewer_user_id: number; submitted_by: string; submitted_by_user_id: number },
): Promise<PlatformTask> {
  let task = taskFor(env, key);
  requireTaskOwner(task, actor);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态可以提交 Review");
  const execution = currentRemoteExecution(env, task);
  if (!execution || execution.role !== "author") throw new PlatformWorkflowError(409, "Task Agent 尚未在 Runner 上启动");
  try {
    const prepared = runtimeResult(await callExecution(env, execution, "execution.prepare-review"));
    const repository = editableRepository(task);
    if (repository.head_commit !== prepared.head_commit) {
      throw new PlatformWorkflowError(409, "最新提交尚未 sync，请让 Agent 重新执行 ay sync");
    }
    if (task.task_type === "repository_init") {
      const hasOverview = task.artifacts.some(
        (artifact) => artifact.kind === "doc" && artifact.path === ".alignyard/docs/shared/overview.md",
      );
      if (repository.manifest_status !== "valid" || !hasOverview) {
        throw new PlatformWorkflowError(409, "初始化 Task 需要先完成 ay validate、ay sync，并提供 shared/overview.md");
      }
    }
    updatePlatformRunnerExecution(env.db, execution.id, { status: "stopped", head_commit: prepared.head_commit || null });
    updatePlatformTaskCommits(env.db, key, { base_commit: prepared.base_commit, head_commit: prepared.head_commit });
    recordPlatformTaskPush(env.db, key, prepared.head_commit!);
    const updated = submitPlatformTaskReview(env.db, key, input);
    if (!updated) throw new PlatformWorkflowError(404, "Task 不存在");
    return updated;
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

export async function startReviewOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  platformUrl: string,
  actor: RunnerWorkflowActor,
  agent: AgentKind = "codex",
  requestedRunnerId?: unknown,
): Promise<{ task: PlatformTask; runtime_created: boolean }> {
  let task = taskFor(env, key);
  if (task.status !== "review" || !task.review || !["pending", "in_progress"].includes(task.review.status)) {
    throw new PlatformWorkflowError(409, "Task 当前不在待 Review 状态");
  }
  const isReviewer = task.review.reviewer_user_id != null
    ? task.review.reviewer_user_id === actor.id
    : task.review.reviewer === actor.name;
  if (!isReviewer) throw new PlatformWorkflowError(403, "只有指定 Reviewer 可以启动 Review Agent");
  const existingId = latestRemoteExecution(env, task, "reviewer");
  const existing = existingId ? getPlatformRunnerExecution(env.db, existingId.id) : undefined;
  if (existing && !existing.runner_task_id && ["queued", "starting"].includes(existing.status)) {
    throw new PlatformWorkflowError(409, "Review Runner execution 正在启动，请稍候");
  }
  if (existing?.runner_task_id && existing.status !== "cleaned") {
    if (!env.gateway.isOnline(existing.runner_id)) {
      throw new PlatformWorkflowError(409, "此 Review 的原 Runner 当前离线；请恢复该 Runner 后继续");
    }
    updatePlatformRunnerExecution(env.db, existing.id, { status: "starting", error: null });
    try {
      await callExecution(env, existing, "execution.resume", {
        env: freshExecutionEnvironment(env, existing.id, task, platformUrl),
      });
    } catch (error) {
      updatePlatformRunnerExecution(env.db, existing.id, { status: "failed", error: errorMessage(error) });
      revokeExecutionTokens(env.db, existing.id);
      setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
      throw error;
    }
    env.db.prepare("UPDATE platform_tasks SET runner_execution_id=?,runtime_task_id=NULL WHERE id=?")
      .run(existing.id, task.id);
    updatePlatformRunnerExecution(env.db, existing.id, { status: "running", error: null });
    return { task: taskFor(env, key), runtime_created: false };
  }

  const repository = editableRepository(task);
  if (!repository.remote_pushed_at || !repository.work_branch) {
    throw new PlatformWorkflowError(409, "Review 分支尚未推送到远端");
  }
  const runner = selectRunner(env, actor, requestedRunnerId, agent);
  const executionId = `rex_${crypto.randomBytes(12).toString("base64url")}`;
  createPlatformRunnerExecution(env.db, key, {
    id: executionId,
    runner_id: runner.id,
    actor: actor.name,
    actor_user_id: actor.id,
    role: "reviewer",
    agent,
  });
  updatePlatformRunnerExecution(env.db, executionId, { status: "starting" });
  const executionEnv = freshExecutionEnvironment(env, executionId, task, platformUrl);
  try {
    const started = runtimeResult(await env.gateway.call(runner.id, "execution.start", {
      execution_id: executionId,
      repository: repositoryInput(task),
      task_key: task.key,
      base_branch: repository.work_branch,
      work_branch: `review/${task.key.toLowerCase()}/${task.review.id}`,
      title: `[${task.key}] Review ${repository.name}`,
      prompt: taskReviewPrompt(task, { syncChanges: true }),
      agent,
      automated: false,
      env: executionEnv,
    }));
    linkPlatformRunnerExecution(env.db, key, executionId, started);
    task = markPlatformTaskReviewStarted(env.db, key) || task;
    return { task: taskFor(env, key), runtime_created: true };
  } catch (error) {
    updatePlatformRunnerExecution(env.db, executionId, { status: "failed", error: errorMessage(error) });
    revokeExecutionTokens(env.db, executionId);
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

export async function decideReviewOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
  decision: "approved" | "changes_requested",
  feedback?: unknown,
): Promise<PlatformTask> {
  let task = taskFor(env, key);
  if (task.status !== "review" || !task.review) throw new PlatformWorkflowError(409, "Task 当前不在 Review");
  const isReviewer = task.review.reviewer_user_id != null
    ? task.review.reviewer_user_id === actor.id
    : task.review.reviewer === actor.name;
  if (!isReviewer) throw new PlatformWorkflowError(403, "只有指定 Reviewer 可以提交 Review 结论");
  const execution = currentRemoteExecution(env, task);
  if (execution?.role === "reviewer" && execution.runner_task_id) {
    if (decision === "approved") {
      const status = runtimeResult(await callExecution(env, execution, "execution.status"));
      const repository = editableRepository(task);
      if (!status.head_commit || status.head_commit !== repository.head_commit) {
        throw new PlatformWorkflowError(409, "Reviewer 修改后的 HEAD 尚未 ay sync，不能批准 Review");
      }
      updatePlatformRunnerExecution(env.db, execution.id, { head_commit: status.head_commit });
    }
    await callExecution(env, execution, decision === "approved" ? "execution.stop" : "execution.cleanup");
    updatePlatformRunnerExecution(env.db, execution.id, { status: decision === "approved" ? "stopped" : "cleaned" });
    revokeExecutionTokens(env.db, execution.id);
  }
  task = decidePlatformTaskReview(env.db, key, decision, feedback) || task;
  task = restoreLatestPlatformAuthorRunnerExecution(env.db, key) || task;
  setPlatformTaskWorkflowError(env.db, key, null);
  return taskFor(env, key);
}

function authorRunnerExecution(env: RunnerWorkflowEnv, task: PlatformTask): PlatformRunnerExecution {
  const latest = latestRemoteExecution(env, task, "author");
  const execution = latest ? getPlatformRunnerExecution(env.db, latest.id) : undefined;
  if (!execution?.runner_task_id) throw new PlatformWorkflowError(409, "Author Runner execution 不存在");
  if (!env.gateway.isOnline(execution.runner_id)) throw new PlatformWorkflowError(409, "Author Runner 当前离线");
  return execution;
}

function changeRequestParams(task: PlatformTask, execution: PlatformRunnerExecution) {
  const repository = editableRepository(task);
  return {
    execution_id: execution.id,
    runner_task_id: execution.runner_task_id,
    base_branch: repository.base_branch,
    head_branch: repository.work_branch,
    title: `[${task.key}] ${task.task_type === "repository_init" ? "Initialize Alignyard knowledge" : task.title}`,
    body: `Alignyard Task: ${task.key}\n\n${task.description || task.title}`,
    number: task.pr_number,
  };
}

export async function createChangeRequestOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
): Promise<PlatformTask> {
  let task = taskFor(env, key);
  requireTaskOwner(task, actor);
  if (task.status !== "approved") throw new PlatformWorkflowError(409, "Task 需要先通过 Review");
  const execution = authorRunnerExecution(env, task);
  const result = await env.gateway.call(execution.runner_id, "change-request.create", changeRequestParams(task, execution)) as ChangeRequestResult;
  recordPlatformPullRequest(env.db, key, result);
  return taskFor(env, key);
}

async function refreshProtocolOnRunner(env: RunnerWorkflowEnv, task: PlatformTask, execution: PlatformRunnerExecution) {
  const repository = editableRepository(task);
  const result = await env.gateway.call(execution.runner_id, "repository.refresh-protocol", {
    repository: repositoryInput(task),
  }) as { state: "uninitialized" | "ready" | "invalid"; error: string | null };
  const refreshed = setPlatformRepositoryProtocolState(env.db, repository.id, result.state, result.error);
  if (!refreshed) throw new PlatformWorkflowError(404, "Repository 不存在");
  return refreshed;
}

async function finishMergedTask(env: RunnerWorkflowEnv, task: PlatformTask, execution: PlatformRunnerExecution) {
  let repository = editableRepository(task);
  if (task.task_type === "repository_init") {
    const refreshed = await refreshProtocolOnRunner(env, task, execution);
    if (refreshed.protocol_state !== "ready") {
      throw new PlatformWorkflowError(409, refreshed.protocol_error || "合并后默认分支尚未通过初始化检查");
    }
    repository = { ...repository, ...refreshed };
  }
  const completed = updatePlatformTaskStatus(env.db, task.key, "completed") || task;
  for (const item of completed.executions.filter((item) => item.runner_execution_id)) {
    const remote = getPlatformRunnerExecution(env.db, item.runner_execution_id!);
    if (!remote?.runner_task_id || !env.gateway.isOnline(remote.runner_id)) continue;
    await callExecution(env, remote, "execution.cleanup").catch(() => {});
    updatePlatformRunnerExecution(env.db, remote.id, { status: "cleaned" });
    revokeExecutionTokens(env.db, remote.id);
  }
  return { task: taskFor(env, task.key), repository };
}

export async function mergeChangeRequestOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
) {
  let task = taskFor(env, key);
  requireTaskOwner(task, actor);
  if (task.status !== "approved" || !task.pr_number) throw new PlatformWorkflowError(409, "需要先批准 Review 并创建合并请求");
  const execution = authorRunnerExecution(env, task);
  if (task.pr_state !== "merged") {
    const result = await env.gateway.call(execution.runner_id, "change-request.merge", changeRequestParams(task, execution)) as ChangeRequestResult;
    recordPlatformPullRequest(env.db, key, result);
    if (result.state !== "merged") throw new PlatformWorkflowError(409, "合并请求尚未合并");
    markPlatformPullRequestMerged(env.db, key);
    task = taskFor(env, key);
  }
  return finishMergedTask(env, task, execution);
}

export async function refreshChangeRequestOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
) {
  let task = taskFor(env, key);
  requireTaskOwner(task, actor);
  if (!task.pr_number || task.status === "completed") return { task };
  const execution = authorRunnerExecution(env, task);
  const result = await env.gateway.call(execution.runner_id, "change-request.refresh", changeRequestParams(task, execution)) as ChangeRequestResult | null;
  if (!result) throw new PlatformWorkflowError(502, "暂时无法确认合并请求状态");
  recordPlatformPullRequest(env.db, key, result);
  task = taskFor(env, key);
  if (result.state !== "merged") return { task };
  markPlatformPullRequestMerged(env.db, key);
  return finishMergedTask(env, taskFor(env, key), execution);
}

export async function refreshRepositoryOnRunner(
  env: RunnerWorkflowEnv,
  repositoryId: number,
  actor: RunnerWorkflowActor,
  requestedRunnerId?: unknown,
) {
  const repository = env.db.prepare(
    "SELECT id,name,git_url,default_branch FROM platform_repositories WHERE id=?",
  ).get(repositoryId) as Record<string, unknown> | undefined;
  if (!repository) throw new PlatformWorkflowError(404, "Repository 不存在");
  const runner = selectRunner(env, actor, requestedRunnerId);
  const result = await env.gateway.call(runner.id, "repository.refresh-protocol", { repository }) as {
    state: "uninitialized" | "ready" | "invalid";
    error: string | null;
  };
  return setPlatformRepositoryProtocolState(env.db, repositoryId, result.state, result.error)!;
}

export async function repositoryBranchesOnRunner(
  env: RunnerWorkflowEnv,
  repositoryId: number,
  actor: RunnerWorkflowActor,
  requestedRunnerId?: unknown,
) {
  const repository = env.db.prepare(
    "SELECT id,name,git_url,default_branch FROM platform_repositories WHERE id=?",
  ).get(repositoryId) as Record<string, unknown> | undefined;
  if (!repository) throw new PlatformWorkflowError(404, "Repository 不存在");
  const runner = selectRunner(env, actor, requestedRunnerId);
  const result = await env.gateway.call(runner.id, "repository.branches", { repository }) as { branches?: string[] } | string[];
  return Array.isArray(result) ? result : result.branches || [];
}

export async function deleteTaskOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
): Promise<PlatformTask> {
  const task = taskFor(env, key);
  requireTaskOwner(task, actor);
  const author = latestRemoteExecution(env, task, "author");
  const execution = author ? getPlatformRunnerExecution(env.db, author.id) : undefined;
  if (task.pr_state === "open" && task.pr_number) {
    if (!execution?.runner_task_id || !env.gateway.isOnline(execution.runner_id)) {
      throw new PlatformWorkflowError(409, "Author Runner 离线，无法安全关闭合并请求");
    }
    const closed = await env.gateway.call(execution.runner_id, "change-request.close", changeRequestParams(task, execution)) as ChangeRequestResult;
    recordPlatformPullRequest(env.db, key, closed);
  }
  for (const item of task.executions.filter((entry) => entry.runner_execution_id)) {
    const remote = getPlatformRunnerExecution(env.db, item.runner_execution_id!);
    if (remote?.runner_task_id && env.gateway.isOnline(remote.runner_id)) {
      await callExecution(env, remote, "execution.cleanup");
    }
    if (remote) revokeExecutionTokens(env.db, remote.id);
  }
  const deleted = deletePlatformTask(env.db, key);
  if (!deleted) throw new PlatformWorkflowError(404, "Task 不存在");
  return deleted;
}

export function runnerForCurrentTask(env: RunnerWorkflowEnv, task: PlatformTask) {
  return task.runner_id ? getRunner(env.db, task.runner_id) : null;
}

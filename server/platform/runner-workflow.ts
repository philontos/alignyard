import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentKind } from "../session/agent.js";
import type { RunnerGateway } from "../runner/gateway.js";
import { getRunner, listUserRunners } from "../runner/registry.js";
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
  knowledgeDesignPrompt,
  repositoryInitializationPrompt,
  repositoryRevisionPrompt,
  taskReviewPrompt,
} from "./prompts.js";
import type { WorktreeInspectRequest } from "../runner/worktree-inspector.js";

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

async function callExecution(
  env: RunnerWorkflowEnv,
  execution: PlatformRunnerExecution,
  method: "execution.status" | "execution.resume" | "execution.stop" | "execution.cleanup" | "execution.message" | "execution.prepare-review" | "execution.knowledge" | "execution.inspect-worktree",
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  if (!execution.runner_task_id) throw new PlatformWorkflowError(409, "Runner Task 尚未创建");
  return env.gateway.call(execution.runner_id, method, {
    execution_id: execution.id,
    runner_task_id: execution.runner_task_id,
    ...extra,
  });
}

function participantExecution(
  env: RunnerWorkflowEnv,
  task: PlatformTask,
  actor: RunnerWorkflowActor,
): PlatformRunnerExecution {
  const isOwner = task.owner_user_id != null ? task.owner_user_id === actor.id : task.owner === actor.name;
  const isReviewer = task.review?.reviewer_user_id != null
    ? task.review.reviewer_user_id === actor.id
    : task.review?.reviewer === actor.name;
  if (!isOwner && !isReviewer) throw new PlatformWorkflowError(403, "只有 Task 参与者可以读取 worktree");
  const row = env.db.prepare(
    "SELECT id FROM platform_runner_executions WHERE task_id=? " +
      "AND (actor_user_id=? OR (actor_user_id IS NULL AND actor=?)) " +
      "AND status<>'cleaned' ORDER BY created_at DESC,id DESC LIMIT 1",
  ).get(task.id, actor.id, actor.name) as { id: string } | undefined;
  const execution = row ? getPlatformRunnerExecution(env.db, row.id) : undefined;
  if (!execution?.runner_task_id) {
    throw new PlatformWorkflowError(409, "请先启动自己的 Agent 工作区，再读取对应 worktree");
  }
  if (!env.gateway.isOnline(execution.runner_id)) throw new PlatformWorkflowError(409, "当前 Runner 离线");
  return execution;
}

export async function taskKnowledgeOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
  documentId?: unknown,
): Promise<unknown> {
  const task = taskFor(env, key);
  const execution = participantExecution(env, task, actor);
  const requested = typeof documentId === "string" && documentId.trim() ? documentId.trim() : undefined;
  return callExecution(env, execution, "execution.knowledge", requested ? { document_id: requested } : {});
}

export async function taskWorktreeOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
  actor: RunnerWorkflowActor,
  request: WorktreeInspectRequest,
): Promise<unknown> {
  const task = taskFor(env, key);
  const execution = participantExecution(env, task, actor);
  if (!request || !["tree", "file", "changes", "diff"].includes(request.operation)) {
    throw new PlatformWorkflowError(400, "worktree 浏览请求无效");
  }
  if (["file", "diff"].includes(request.operation) && typeof request.path !== "string") {
    throw new PlatformWorkflowError(400, "请选择要读取的文件");
  }
  return callExecution(env, execution, "execution.inspect-worktree", {
    operation: request.operation,
    ...(typeof request.path === "string" ? { path: request.path } : {}),
  });
}

export async function startTaskOnRunner(
  env: RunnerWorkflowEnv,
  key: string,
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
  let activeExecutionId: string | undefined;

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
      activeExecutionId = existing.id;
      await callExecution(env, existing, "execution.resume");
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
    activeExecutionId = executionId;
    const prompt = revision
      ? repositoryRevisionPrompt(task)
      : task.task_type === "repository_init"
        ? repositoryInitializationPrompt({ task, ayCommand: "ay" })
        : knowledgeDesignPrompt(task);
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
    }));
    task = linkPlatformRunnerExecution(env.db, key, executionId, started) || task;
    if (revision) markPlatformReviewFeedbackDelivered(env.db, key);
    return { task: taskFor(env, key), runtime_created: true };
  } catch (error) {
    if (activeExecutionId) updatePlatformRunnerExecution(
      env.db, activeExecutionId, { status: "failed", error: errorMessage(error) },
    );
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
    updatePlatformRunnerExecution(env.db, execution.id, { status: "stopped", head_commit: prepared.head_commit || null });
    updatePlatformTaskCommits(
      env.db,
      key,
      { base_commit: prepared.base_commit, head_commit: prepared.head_commit },
      repository.id,
    );
    recordPlatformTaskPush(env.db, key, prepared.head_commit!, repository.id);
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
      await callExecution(env, existing, "execution.resume");
    } catch (error) {
      updatePlatformRunnerExecution(env.db, existing.id, { status: "failed", error: errorMessage(error) });
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
  try {
    const started = runtimeResult(await env.gateway.call(runner.id, "execution.start", {
      execution_id: executionId,
      repository: repositoryInput(task),
      task_key: task.key,
      base_branch: repository.work_branch,
      work_branch: `review/${task.key.toLowerCase()}/${task.review.id}`,
      title: `[${task.key}] Review ${repository.name}`,
      prompt: taskReviewPrompt(task),
      agent,
      automated: false,
    }));
    linkPlatformRunnerExecution(env.db, key, executionId, started);
    task = markPlatformTaskReviewStarted(env.db, key) || task;
    return { task: taskFor(env, key), runtime_created: true };
  } catch (error) {
    updatePlatformRunnerExecution(env.db, executionId, { status: "failed", error: errorMessage(error) });
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
      const status = runtimeResult(await callExecution(env, execution, "execution.prepare-review", {
        push_branch: editableRepository(task).work_branch,
        allow_unchanged: true,
      }));
      const repository = editableRepository(task);
      if (!status.head_commit) throw new PlatformWorkflowError(502, "Runner 未返回审核提交");
      updatePlatformTaskCommits(env.db, key, { head_commit: status.head_commit }, repository.id);
      recordPlatformTaskPush(env.db, key, status.head_commit, repository.id);
      updatePlatformRunnerExecution(env.db, execution.id, { head_commit: status.head_commit });
    }
    if (decision !== "approved") await callExecution(env, execution, "execution.cleanup");
    updatePlatformRunnerExecution(env.db, execution.id, { status: decision === "approved" ? "stopped" : "cleaned" });
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
  if (task.task_type !== "repository_init") {
    throw new PlatformWorkflowError(409, "普通 Task 已形成设计基线；实现与合并闭环将在后续能力中处理");
  }
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
  }
  const deleted = deletePlatformTask(env.db, key);
  if (!deleted) throw new PlatformWorkflowError(404, "Task 不存在");
  return deleted;
}

export function runnerForCurrentTask(env: RunnerWorkflowEnv, task: PlatformTask) {
  return task.runner_id ? getRunner(env.db, task.runner_id) : null;
}

import type Database from "better-sqlite3";
import { repositoryForgeKind, type RepositoryForgeKind } from "./forge.js";
import { listAuthenticatedUsers, publicPlatformUser, type PublicPlatformUser } from "../auth/auth.js";

type DB = Database.Database;

export const PLATFORM_TASK_STATUSES = [
  "draft",
  "review",
  "approved",
  "completed",
] as const;

export type PlatformTaskStatus = typeof PLATFORM_TASK_STATUSES[number];
export const PLATFORM_TASK_TYPES = ["change", "repository_init"] as const;
export const REPOSITORY_PROTOCOL_STATES = ["uninitialized", "initializing", "ready", "invalid"] as const;
export type PlatformTaskType = typeof PLATFORM_TASK_TYPES[number];
export type RepositoryProtocolState = typeof REPOSITORY_PROTOCOL_STATES[number];
export type RepositoryMode = "editable" | "reference";

export interface PlatformRepository {
  id: number;
  name: string;
  git_url: string;
  forge_kind: RepositoryForgeKind;
  default_branch: string;
  protocol_initialized: boolean;
  protocol_state: RepositoryProtocolState;
  protocol_error: string | null;
  created_by: string;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

type PlatformRepositoryRow = Omit<PlatformRepository, "protocol_initialized" | "forge_kind"> & { protocol_initialized: number };

function shapeRepository(row: PlatformRepositoryRow): PlatformRepository {
  return {
    ...row,
    forge_kind: repositoryForgeKind(row.git_url),
    protocol_initialized: row.protocol_initialized === 1,
  };
}

export interface TaskRepositoryInput {
  repository_id: number;
  mode: RepositoryMode;
  base_branch?: string;
  assignee?: string | null;
}

export interface PlatformTaskRepository extends PlatformRepository {
  mode: RepositoryMode;
  base_branch: string;
  base_commit: string | null;
  work_branch: string | null;
  head_commit: string | null;
  assignee: string | null;
  manifest_status: string;
  last_reported_at: string | null;
  remote_pushed_at: string | null;
}

export type PlatformReviewStatus = "pending" | "in_progress" | "changes_requested" | "approved";

export interface PlatformTaskReview {
  id: number;
  reviewer: string;
  reviewer_user_id: number | null;
  submitted_by: string;
  submitted_by_user_id: number | null;
  status: PlatformReviewStatus;
  feedback: string | null;
  feedback_delivered_at: string | null;
  submitted_at: string;
  started_at: string | null;
  decided_at: string | null;
  updated_at: string;
}

export interface PlatformTaskExecution {
  id: number | string;
  runtime_task_id: number | null;
  runner_execution_id: string | null;
  runner_id: string | null;
  actor: string;
  role: "author" | "reviewer";
  agent: string | null;
  status: "active" | "queued" | "starting" | "running" | "waiting" | "stopped" | "failed" | "cleaned";
  created_at: string;
  updated_at: string;
}

export interface PlatformArtifact {
  id: number;
  task_id: number;
  repository_id: number;
  repository_name: string;
  task_key: string;
  kind: string;
  path: string;
  title: string | null;
  change_kind: string | null;
  review_status: string;
  base_commit: string | null;
  head_commit: string | null;
  updated_at: string;
}

export interface PlatformTask {
  id: number;
  key: string;
  title: string;
  description: string | null;
  owner: string;
  owner_user_id: number | null;
  current_assignee: string;
  current_assignee_user_id: number | null;
  task_type: PlatformTaskType;
  status: PlatformTaskStatus;
  runner_execution_id: string | null;
  runner_id: string | null;
  runtime_task_id: number | null;
  runtime_status: string | null;
  runtime_error: string | null;
  runtime_worktree: string | null;
  runtime_session: string | null;
  runtime_agent: string | null;
  workflow_error: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: "none" | "open" | "merged" | "closed";
  merged_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  repositories: PlatformTaskRepository[];
  artifacts: PlatformArtifact[];
  review: PlatformTaskReview | null;
  executions: PlatformTaskExecution[];
}

export class PlatformValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformValidationError";
  }
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new PlatformValidationError(`${label}不能为空`);
  return text;
}

function requireCredentialFreeGitUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  const httpCredential = ["http:", "https:"].includes(url.protocol) && !!url.username;
  const sensitiveQuery = [...url.searchParams.keys()].some((key) =>
    /^(access_?token|auth|authorization|password|private_?token|token)$/i.test(key),
  );
  if (httpCredential || url.password || sensitiveQuery) {
    throw new PlatformValidationError("Git 地址不能包含用户名、密码或 token");
  }
  return value;
}

function branchSlug(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "member";
}

export function listPlatformRepositories(db: DB): PlatformRepository[] {
  const rows = db.prepare(
    "SELECT id,name,git_url,default_branch,protocol_initialized,protocol_state,protocol_error," +
      "created_by,created_by_user_id,created_at,updated_at " +
      "FROM platform_repositories ORDER BY updated_at DESC,id DESC",
  ).all() as PlatformRepositoryRow[];
  return rows.map(shapeRepository);
}

export function getPlatformRepository(db: DB, id: number): PlatformRepository | undefined {
  const row = db.prepare(
    "SELECT id,name,git_url,default_branch,protocol_initialized,protocol_state,protocol_error," +
      "created_by,created_by_user_id,created_at,updated_at " +
      "FROM platform_repositories WHERE id=?",
  ).get(id) as PlatformRepositoryRow | undefined;
  return row ? shapeRepository(row) : undefined;
}

export function setPlatformRepositoryProtocolState(
  db: DB,
  id: number,
  state: RepositoryProtocolState,
  error: string | null = null,
): PlatformRepository | undefined {
  const changed = db.prepare(
    "UPDATE platform_repositories SET protocol_initialized=?,protocol_state=?,protocol_error=?," +
      "updated_at=datetime('now') WHERE id=?",
  ).run(state === "ready" ? 1 : 0, state, error, id).changes;
  return changed ? getPlatformRepository(db, id) : undefined;
}

export function createPlatformRepository(db: DB, input: Record<string, unknown>): PlatformRepository {
  const name = requiredText(input.name, "Repository 名称");
  const gitUrl = requireCredentialFreeGitUrl(requiredText(input.git_url, "Git 地址"));
  const defaultBranch = typeof input.default_branch === "string" && input.default_branch.trim()
    ? input.default_branch.trim()
    : "main";
  const createdBy = typeof input.created_by === "string" && input.created_by.trim()
    ? input.created_by.trim()
    : "当前用户";
  const createdByUserId = Number.isInteger(Number(input.created_by_user_id)) && Number(input.created_by_user_id) > 0
    ? Number(input.created_by_user_id)
    : null;

  try {
    const result = db.prepare(
      "INSERT INTO platform_repositories " +
        "(name,git_url,default_branch,created_by,created_by_user_id) VALUES (?,?,?,?,?)",
    ).run(name, gitUrl, defaultBranch, createdBy, createdByUserId);
    const repository = getPlatformRepository(db, Number(result.lastInsertRowid));
    if (!repository) throw new Error("Repository 创建后未找到");
    return repository;
  } catch (error: any) {
    if (String(error?.message || error).includes("UNIQUE constraint failed")) {
      throw new PlatformValidationError("名称或 Git 地址已登记");
    }
    throw error;
  }
}

type TaskRow = Omit<PlatformTask, "key" | "repositories" | "artifacts" | "review" | "executions"> & { task_key: string };

function artifactsForTask(db: DB, taskId: number): PlatformArtifact[] {
  return db.prepare(
    "SELECT a.id,a.task_id,a.repository_id,r.name AS repository_name,t.task_key," +
      "a.kind,a.path,a.title,a.change_kind,a.review_status,a.base_commit,a.head_commit,a.updated_at " +
      "FROM platform_artifacts a " +
      "JOIN platform_repositories r ON r.id=a.repository_id " +
      "JOIN platform_tasks t ON t.id=a.task_id " +
      "WHERE a.task_id=? ORDER BY a.kind,r.name,a.path",
  ).all(taskId) as PlatformArtifact[];
}

function repositoriesForTask(db: DB, taskId: number): PlatformTaskRepository[] {
  const rows = db.prepare(
    "SELECT r.id,r.name,r.git_url,r.default_branch,r.protocol_initialized,r.protocol_state,r.protocol_error," +
      "r.created_by,r.created_by_user_id,r.created_at,r.updated_at," +
      "tr.mode,tr.base_branch,tr.base_commit,tr.work_branch,tr.head_commit,tr.assignee," +
      "tr.manifest_status,tr.last_reported_at,tr.remote_pushed_at " +
      "FROM platform_task_repositories tr " +
      "JOIN platform_repositories r ON r.id=tr.repository_id " +
      "WHERE tr.task_id=? ORDER BY CASE tr.mode WHEN 'editable' THEN 0 ELSE 1 END,r.name",
  ).all(taskId) as (Omit<PlatformTaskRepository, "protocol_initialized" | "forge_kind"> & { protocol_initialized: number })[];
  return rows.map((row) => ({
    ...row,
    forge_kind: repositoryForgeKind(row.git_url),
    protocol_initialized: row.protocol_initialized === 1,
  }));
}

function reviewForTask(db: DB, taskId: number): PlatformTaskReview | null {
  return (db.prepare(
    "SELECT id,reviewer,reviewer_user_id,submitted_by,submitted_by_user_id,status,feedback,feedback_delivered_at," +
      "submitted_at,started_at,decided_at,updated_at " +
      "FROM platform_task_reviews WHERE task_id=? ORDER BY id DESC LIMIT 1",
  ).get(taskId) as PlatformTaskReview | undefined) || null;
}

function executionsForTask(db: DB, taskId: number): PlatformTaskExecution[] {
  const local = db.prepare(
    "SELECT id,runtime_task_id,actor,role,agent,status,created_at,updated_at " +
      "FROM platform_task_executions WHERE task_id=? ORDER BY id",
  ).all(taskId) as Omit<PlatformTaskExecution, "runner_execution_id" | "runner_id">[];
  const remote = db.prepare(
    "SELECT id,runner_task_id AS runtime_task_id,id AS runner_execution_id,runner_id," +
      "actor,role,agent,status,created_at,updated_at " +
      "FROM platform_runner_executions WHERE task_id=? ORDER BY created_at,id",
  ).all(taskId) as PlatformTaskExecution[];
  return [
    ...local.map((execution) => ({ ...execution, runner_execution_id: null, runner_id: null })),
    ...remote,
  ].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function shapeTask(db: DB, row: TaskRow): PlatformTask {
  return {
    id: row.id,
    key: row.task_key,
    title: row.title,
    description: row.description,
    owner: row.owner,
    owner_user_id: row.owner_user_id,
    current_assignee: row.current_assignee,
    current_assignee_user_id: row.current_assignee_user_id,
    task_type: row.task_type,
    status: row.status,
    runner_execution_id: row.runner_execution_id,
    runner_id: row.runner_id,
    runtime_task_id: row.runtime_task_id,
    runtime_status: row.runtime_status,
    runtime_error: row.runtime_error,
    runtime_worktree: row.runtime_worktree,
    runtime_session: row.runtime_session,
    runtime_agent: row.runtime_agent,
    workflow_error: row.workflow_error,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    pr_state: row.pr_state,
    merged_at: row.merged_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    repositories: repositoriesForTask(db, row.id),
    artifacts: artifactsForTask(db, row.id),
    review: reviewForTask(db, row.id),
    executions: executionsForTask(db, row.id),
  };
}

export function listPlatformTasks(db: DB): PlatformTask[] {
  const rows = db.prepare(
    "SELECT pt.id,pt.task_key,pt.title,pt.description,pt.owner,pt.owner_user_id," +
      "pt.current_assignee,pt.current_assignee_user_id,pt.task_type,pt.status," +
      "pt.runner_execution_id,re.runner_id,COALESCE(re.runner_task_id,pt.runtime_task_id) AS runtime_task_id," +
      "COALESCE(re.status,rt.status) AS runtime_status,COALESCE(re.error,rt.error) AS runtime_error," +
      "rt.worktree_path AS runtime_worktree,COALESCE(re.session,rt.session) AS runtime_session," +
      "COALESCE(re.agent,rt.agent) AS runtime_agent," +
      "pt.workflow_error,pt.pr_number,pt.pr_url,pt.pr_state,pt.merged_at,pt.completed_at,pt.created_at,pt.updated_at " +
      "FROM platform_tasks pt LEFT JOIN tasks rt ON rt.id=pt.runtime_task_id " +
      "LEFT JOIN platform_runner_executions re ON re.id=pt.runner_execution_id " +
      "ORDER BY pt.updated_at DESC,pt.id DESC",
  ).all() as TaskRow[];
  return rows.map((row) => shapeTask(db, row));
}

export function getPlatformTask(db: DB, key: string): PlatformTask | undefined {
  const row = db.prepare(
    "SELECT pt.id,pt.task_key,pt.title,pt.description,pt.owner,pt.owner_user_id," +
      "pt.current_assignee,pt.current_assignee_user_id,pt.task_type,pt.status," +
      "pt.runner_execution_id,re.runner_id,COALESCE(re.runner_task_id,pt.runtime_task_id) AS runtime_task_id," +
      "COALESCE(re.status,rt.status) AS runtime_status,COALESCE(re.error,rt.error) AS runtime_error," +
      "rt.worktree_path AS runtime_worktree,COALESCE(re.session,rt.session) AS runtime_session," +
      "COALESCE(re.agent,rt.agent) AS runtime_agent," +
      "pt.workflow_error,pt.pr_number,pt.pr_url,pt.pr_state,pt.merged_at,pt.completed_at,pt.created_at,pt.updated_at " +
      "FROM platform_tasks pt LEFT JOIN tasks rt ON rt.id=pt.runtime_task_id " +
      "LEFT JOIN platform_runner_executions re ON re.id=pt.runner_execution_id WHERE pt.task_key=?",
  ).get(key.toUpperCase()) as TaskRow | undefined;
  return row ? shapeTask(db, row) : undefined;
}

export function linkPlatformTaskRuntime(
  db: DB,
  key: string,
  runtime: {
    id: number;
    work_branch: string;
    base_commit: string | null;
    actor?: string;
    role?: "author" | "reviewer";
    agent?: string | null;
  },
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.transaction(() => {
    db.prepare(
      "UPDATE platform_tasks SET runtime_task_id=?,runner_execution_id=NULL,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(runtime.id, task.id);
    db.prepare(
      "UPDATE platform_task_repositories SET work_branch=?,base_commit=COALESCE(?,base_commit) " +
        "WHERE task_id=? AND mode='editable'",
    ).run(runtime.work_branch, runtime.base_commit, task.id);
    db.prepare(
      "INSERT INTO platform_task_executions (task_id,runtime_task_id,actor,role,agent,status) " +
        "VALUES (?,?,?,?,?,'active') " +
        "ON CONFLICT(task_id,runtime_task_id) DO UPDATE SET actor=excluded.actor,role=excluded.role," +
        "agent=excluded.agent,status='active',updated_at=datetime('now')",
    ).run(task.id, runtime.id, runtime.actor || task.current_assignee || task.owner, runtime.role || "author", runtime.agent || null);
  })();
  return getPlatformTask(db, key);
}

export interface PlatformRunnerExecution {
  id: string;
  task_id: number;
  runner_id: string;
  runner_task_id: number | null;
  actor: string;
  actor_user_id: number;
  role: "author" | "reviewer";
  agent: string;
  status: "queued" | "starting" | "running" | "waiting" | "stopped" | "failed" | "cleaned";
  session: string | null;
  work_branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function getPlatformRunnerExecution(db: DB, id: string): PlatformRunnerExecution | undefined {
  return db.prepare(
    "SELECT id,task_id,runner_id,runner_task_id,actor,actor_user_id,role,agent,status,session," +
      "work_branch,base_commit,head_commit,error,created_at,updated_at " +
      "FROM platform_runner_executions WHERE id=?",
  ).get(id) as PlatformRunnerExecution | undefined;
}

export function createPlatformRunnerExecution(
  db: DB,
  key: string,
  input: { id: string; runner_id: string; actor: string; actor_user_id: number; role: "author" | "reviewer"; agent: string },
): PlatformRunnerExecution | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.transaction(() => {
    db.prepare(
      "INSERT INTO platform_runner_executions " +
        "(id,task_id,runner_id,actor,actor_user_id,role,agent,status) VALUES (?,?,?,?,?,?,?,'queued')",
    ).run(input.id, task.id, input.runner_id, input.actor, input.actor_user_id, input.role, input.agent);
    db.prepare(
      "UPDATE platform_tasks SET runner_execution_id=?,runtime_task_id=NULL,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(input.id, task.id);
  })();
  return getPlatformRunnerExecution(db, input.id);
}

export function updatePlatformRunnerExecution(
  db: DB,
  id: string,
  input: Partial<Pick<PlatformRunnerExecution,
    "runner_task_id" | "status" | "session" | "work_branch" | "base_commit" | "head_commit" | "error">>,
): PlatformRunnerExecution | undefined {
  const current = getPlatformRunnerExecution(db, id);
  if (!current) return undefined;
  db.prepare(
    "UPDATE platform_runner_executions SET runner_task_id=?,status=?,session=?,work_branch=?,base_commit=?," +
      "head_commit=?,error=?,updated_at=datetime('now') WHERE id=?",
  ).run(
    input.runner_task_id ?? current.runner_task_id,
    input.status ?? current.status,
    input.session ?? current.session,
    input.work_branch ?? current.work_branch,
    input.base_commit ?? current.base_commit,
    input.head_commit ?? current.head_commit,
    input.error === undefined ? current.error : input.error,
    id,
  );
  return getPlatformRunnerExecution(db, id);
}

export function linkPlatformRunnerExecution(
  db: DB,
  key: string,
  id: string,
  runtime: { runner_task_id: number; session?: string | null; status?: PlatformRunnerExecution["status"]; work_branch: string; base_commit?: string | null },
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  const execution = getPlatformRunnerExecution(db, id);
  if (!task || !execution) return undefined;
  db.transaction(() => {
    updatePlatformRunnerExecution(db, id, {
      runner_task_id: runtime.runner_task_id,
      session: runtime.session ?? null,
      status: runtime.status || "running",
      work_branch: runtime.work_branch,
      base_commit: runtime.base_commit ?? null,
      error: null,
    });
    db.prepare(
      "UPDATE platform_tasks SET runner_execution_id=?,runtime_task_id=NULL,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(id, task.id);
    // A reviewer uses an isolated local branch and may push HEAD to the
    // author's remote branch. Only author executions define the Task's branch.
    if (execution.role === "author") {
      db.prepare(
        "UPDATE platform_task_repositories SET work_branch=?,base_commit=COALESCE(?,base_commit) " +
          "WHERE task_id=? AND mode='editable'",
      ).run(runtime.work_branch, runtime.base_commit ?? null, task.id);
    }
  })();
  return getPlatformTask(db, key);
}

export function restoreLatestPlatformAuthorRunnerExecution(db: DB, key: string): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  const execution = db.prepare(
    "SELECT id FROM platform_runner_executions WHERE task_id=? AND role='author' ORDER BY created_at DESC,id DESC LIMIT 1",
  ).get(task.id) as { id: string } | undefined;
  if (!execution) return task;
  db.prepare(
    "UPDATE platform_tasks SET runner_execution_id=?,runtime_task_id=NULL,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
  ).run(execution.id, task.id);
  return getPlatformTask(db, key);
}

export function updatePlatformTaskExecutionStatus(
  db: DB,
  key: string,
  runtimeTaskId: number,
  status: PlatformTaskExecution["status"],
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.prepare(
    "UPDATE platform_task_executions SET status=?,updated_at=datetime('now') WHERE task_id=? AND runtime_task_id=?",
  ).run(status, task.id, runtimeTaskId);
  return getPlatformTask(db, key);
}

export function recordPlatformTaskPush(
  db: DB,
  key: string,
  headCommit: string,
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.prepare(
    "UPDATE platform_task_repositories SET head_commit=?,remote_pushed_at=datetime('now')," +
      "last_reported_at=datetime('now') WHERE task_id=? AND mode='editable'",
  ).run(headCommit, task.id);
  return getPlatformTask(db, key);
}

export function submitPlatformTaskReview(
  db: DB,
  key: string,
  input: {
    reviewer: unknown;
    reviewer_user_id?: unknown;
    submitted_by: unknown;
    submitted_by_user_id?: unknown;
  },
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  const reviewer = requiredText(input.reviewer, "Reviewer");
  const submittedBy = requiredText(input.submitted_by, "提交人");
  const reviewerUserId = Number.isInteger(Number(input.reviewer_user_id)) && Number(input.reviewer_user_id) > 0
    ? Number(input.reviewer_user_id)
    : null;
  const submittedByUserId = Number.isInteger(Number(input.submitted_by_user_id)) && Number(input.submitted_by_user_id) > 0
    ? Number(input.submitted_by_user_id)
    : null;
  db.transaction(() => {
    db.prepare(
      "INSERT INTO platform_task_reviews " +
        "(task_id,reviewer,reviewer_user_id,submitted_by,submitted_by_user_id,status) " +
        "VALUES (?,?,?,?,?,'pending')",
    ).run(task.id, reviewer, reviewerUserId, submittedBy, submittedByUserId);
    db.prepare(
      "UPDATE platform_tasks SET status='review',current_assignee=?,current_assignee_user_id=?," +
        "workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(reviewer, reviewerUserId, task.id);
  })();
  return getPlatformTask(db, key);
}

export function markPlatformTaskReviewStarted(db: DB, key: string): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task?.review || !["pending", "in_progress"].includes(task.review.status)) return task;
  db.prepare(
    "UPDATE platform_task_reviews SET status='in_progress',started_at=COALESCE(started_at,datetime('now'))," +
      "updated_at=datetime('now') WHERE id=?",
  ).run(task.review.id);
  return getPlatformTask(db, key);
}

export function decidePlatformTaskReview(
  db: DB,
  key: string,
  decision: "approved" | "changes_requested",
  feedback?: unknown,
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task?.review) return task;
  const reviewFeedback = typeof feedback === "string" && feedback.trim() ? feedback.trim() : null;
  if (decision === "changes_requested" && !reviewFeedback) {
    throw new PlatformValidationError("请填写需要修改的内容");
  }
  db.transaction(() => {
    db.prepare(
      "UPDATE platform_task_reviews SET status=?,feedback=?,feedback_delivered_at=NULL," +
        "decided_at=datetime('now'),updated_at=datetime('now') WHERE id=?",
    ).run(decision, reviewFeedback, task.review!.id);
    db.prepare(
      "UPDATE platform_tasks SET status=?,current_assignee=?,current_assignee_user_id=?," +
        "updated_at=datetime('now') WHERE id=?",
    ).run(decision === "approved" ? "approved" : "draft", task.owner, task.owner_user_id, task.id);
    if (decision === "changes_requested" && task.task_type === "repository_init") {
      db.prepare(
        "UPDATE platform_task_repositories SET manifest_status='waiting' WHERE task_id=? AND mode='editable'",
      ).run(task.id);
    }
  })();
  return getPlatformTask(db, key);
}

export function restoreLatestPlatformAuthorRuntime(db: DB, key: string): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  const execution = db.prepare(
    "SELECT runtime_task_id FROM platform_task_executions " +
      "WHERE task_id=? AND role='author' ORDER BY id DESC LIMIT 1",
  ).get(task.id) as { runtime_task_id: number } | undefined;
  if (!execution) return task;
  db.prepare(
    "UPDATE platform_tasks SET runtime_task_id=?,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
  ).run(execution.runtime_task_id, task.id);
  return getPlatformTask(db, key);
}

export function markPlatformReviewFeedbackDelivered(db: DB, key: string): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task?.review) return task;
  db.prepare(
    "UPDATE platform_task_reviews SET feedback_delivered_at=datetime('now'),updated_at=datetime('now') WHERE id=?",
  ).run(task.review.id);
  return getPlatformTask(db, key);
}

export function listPlatformMembers(db: DB): PublicPlatformUser[] {
  return listAuthenticatedUsers(db).map(publicPlatformUser);
}

export function setPlatformTaskWorkflowError(db: DB, key: string, error: string | null): PlatformTask | undefined {
  const changed = db.prepare(
    "UPDATE platform_tasks SET workflow_error=?,updated_at=datetime('now') WHERE task_key=?",
  ).run(error, key.toUpperCase()).changes;
  return changed ? getPlatformTask(db, key) : undefined;
}

export function updatePlatformTaskCommits(
  db: DB,
  key: string,
  commits: { base_commit?: string | null; head_commit?: string | null },
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.prepare(
    "UPDATE platform_task_repositories SET base_commit=COALESCE(?,base_commit)," +
      "head_commit=COALESCE(?,head_commit),last_reported_at=datetime('now') " +
      "WHERE task_id=? AND mode='editable'",
  ).run(commits.base_commit ?? null, commits.head_commit ?? null, task.id);
  return getPlatformTask(db, key);
}

export function recordPlatformPullRequest(
  db: DB,
  key: string,
  pullRequest: { number: number; url: string; state: "open" | "merged" | "closed" },
): PlatformTask | undefined {
  const changed = db.prepare(
    "UPDATE platform_tasks SET pr_number=?,pr_url=?,pr_state=?,workflow_error=NULL," +
      "updated_at=datetime('now') WHERE task_key=?",
  ).run(pullRequest.number, pullRequest.url, pullRequest.state, key.toUpperCase()).changes;
  return changed ? getPlatformTask(db, key) : undefined;
}

export function markPlatformPullRequestMerged(db: DB, key: string): PlatformTask | undefined {
  const changed = db.prepare(
    "UPDATE platform_tasks SET pr_state='merged',merged_at=datetime('now'),workflow_error=NULL," +
      "updated_at=datetime('now') WHERE task_key=?",
  ).run(key.toUpperCase()).changes;
  return changed ? getPlatformTask(db, key) : undefined;
}

export function createPlatformTask(db: DB, input: Record<string, unknown>): PlatformTask {
  const title = requiredText(input.title, "Task 标题");
  const owner = requiredText(input.owner, "负责人");
  const ownerUserId = Number.isInteger(Number(input.owner_user_id)) && Number(input.owner_user_id) > 0
    ? Number(input.owner_user_id)
    : null;
  const taskType = input.task_type == null ? "change" : String(input.task_type) as PlatformTaskType;
  if (!PLATFORM_TASK_TYPES.includes(taskType)) throw new PlatformValidationError("Task 类型无效");
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim()
    : null;
  const repositories = Array.isArray(input.repositories)
    ? input.repositories as TaskRepositoryInput[]
    : [];
  if (!repositories.length) throw new PlatformValidationError("至少关联一个 Repository");
  if (!repositories.some((item) => item?.mode === "editable")) {
    throw new PlatformValidationError("至少选择一个 editable Repository");
  }
  if (taskType === "repository_init" && (repositories.length !== 1 || repositories[0]?.mode !== "editable")) {
    throw new PlatformValidationError("Repository 初始化 Task 必须且只能关联一个 editable Repository");
  }

  const normalized = repositories.map((item) => {
    const repositoryId = Number(item?.repository_id);
    if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
      throw new PlatformValidationError("Repository 无效");
    }
    if (item.mode !== "editable" && item.mode !== "reference") {
      throw new PlatformValidationError("Repository mode 必须是 editable 或 reference");
    }
    return { ...item, repository_id: repositoryId };
  });
  if (new Set(normalized.map((item) => item.repository_id)).size !== normalized.length) {
    throw new PlatformValidationError("同一个 Repository 不能重复关联");
  }

  const create = db.transaction(() => {
    const taskInfo = db.prepare(
      "INSERT INTO platform_tasks " +
        "(task_key,title,description,owner,owner_user_id,current_assignee,current_assignee_user_id,task_type) " +
        "VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      `pending-${Date.now()}-${Math.random()}`,
      title,
      description,
      owner,
      ownerUserId,
      owner,
      ownerUserId,
      taskType,
    );
    const taskId = Number(taskInfo.lastInsertRowid);
    const key = `AY-${String(taskId).padStart(3, "0")}`;
    db.prepare("UPDATE platform_tasks SET task_key=? WHERE id=?").run(key, taskId);

    const repoQuery = db.prepare(
      "SELECT id,default_branch,protocol_state FROM platform_repositories WHERE id=?",
    );
    const insert = db.prepare(
      "INSERT INTO platform_task_repositories " +
        "(task_id,repository_id,mode,base_branch,work_branch,assignee) VALUES (?,?,?,?,?,?)",
    );
    for (const item of normalized) {
      const repository = repoQuery.get(item.repository_id) as {
        id: number;
        default_branch: string;
        protocol_state: RepositoryProtocolState;
      } | undefined;
      if (!repository) throw new PlatformValidationError(`Repository #${item.repository_id} 不存在`);
      if (taskType === "change" && item.mode === "editable" && repository.protocol_state !== "ready") {
        throw new PlatformValidationError(
          `Repository #${item.repository_id} 尚未完成 Alignyard 初始化，请先运行 Initialize`,
        );
      }
      const baseBranch = typeof item.base_branch === "string" && item.base_branch.trim()
        ? item.base_branch.trim()
        : repository.default_branch;
      const assignee = typeof item.assignee === "string" && item.assignee.trim()
        ? item.assignee.trim()
        : owner;
      const workBranch = item.mode === "editable"
        ? `change/${key.toLowerCase()}/${branchSlug(assignee)}`
        : null;
      insert.run(taskId, item.repository_id, item.mode, baseBranch, workBranch, assignee);
    }
    if (taskType === "repository_init") {
      db.prepare(
        "UPDATE platform_repositories SET protocol_initialized=0,protocol_state='initializing'," +
          "protocol_error=NULL,updated_at=datetime('now') WHERE id=?",
      ).run(normalized[0].repository_id);
    }
    return key;
  });

  const task = getPlatformTask(db, create());
  if (!task) throw new Error("Task 创建后未找到");
  return task;
}

/** Create (or return) the single active bootstrap Task for one Repository. */
export function createRepositoryInitializationTask(
  db: DB,
  repositoryId: number,
  ownerValue: unknown,
  ownerUserId: number | null = null,
): PlatformTask {
  const repository = getPlatformRepository(db, repositoryId);
  if (!repository) throw new PlatformValidationError("Repository 不存在");
  if (repository.protocol_state === "ready") throw new PlatformValidationError("Repository 已完成初始化");

  const existing = db.prepare(
    "SELECT t.task_key FROM platform_tasks t " +
      "JOIN platform_task_repositories tr ON tr.task_id=t.id " +
      "WHERE tr.repository_id=? AND t.task_type='repository_init' " +
      "AND t.status IN ('draft','review','approved') ORDER BY t.id DESC LIMIT 1",
  ).get(repositoryId) as { task_key: string } | undefined;
  if (existing) {
    const task = getPlatformTask(db, existing.task_key);
    if (task) return task;
  }

  const owner = typeof ownerValue === "string" && ownerValue.trim() ? ownerValue.trim() : "当前用户";
  return createPlatformTask(db, {
    task_type: "repository_init",
    title: `Initialize Alignyard · ${repository.name}`,
    description:
      `为 ${repository.name} 建立版本化工程知识：运行 ay init，按 alignyard-knowledge Skill ` +
      "盘点仓库事实并梳理 scopes、架构、稳定接口与维护流程等基础 Docs，运行 ay validate、ay sync，提交 Review 后合并到默认分支。",
    owner,
    owner_user_id: ownerUserId,
    repositories: [{ repository_id: repository.id, mode: "editable", base_branch: repository.default_branch }],
  });
}

export function platformRepositoryTaskCount(db: DB, repositoryId: number): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS count FROM platform_task_repositories WHERE repository_id=?",
  ).get(repositoryId) as { count: number } | undefined)?.count || 0);
}

/** Delete shared metadata only after callers have removed the owner-local clone. */
export function deletePlatformRepository(db: DB, repositoryId: number): PlatformRepository | undefined {
  const repository = getPlatformRepository(db, repositoryId);
  if (!repository) return undefined;
  const taskCount = platformRepositoryTaskCount(db, repositoryId);
  if (taskCount) {
    throw new PlatformValidationError(`Repository 已被 ${taskCount} 个 Task 引用，不能删除`);
  }
  db.prepare("DELETE FROM platform_repositories WHERE id=?").run(repositoryId);
  return repository;
}

/** Remove one platform Task and its current knowledge snapshot. Runtime and
 * forge resources are cleaned by the workflow layer before this local
 * transaction runs. An unfinished Repository Init releases its repository so
 * a fresh initialization Task can be created. */
export function deletePlatformTask(db: DB, key: string): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.transaction(() => {
    db.prepare(
      "DELETE FROM platform_execution_tokens WHERE execution_id IN " +
        "(SELECT id FROM platform_runner_executions WHERE task_id=?)",
    ).run(task.id);
    db.prepare("DELETE FROM platform_runner_executions WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM platform_task_executions WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM platform_task_reviews WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM platform_artifacts WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM platform_task_repositories WHERE task_id=?").run(task.id);
    db.prepare("DELETE FROM platform_tasks WHERE id=?").run(task.id);
    if (task.task_type === "repository_init" && task.pr_state !== "merged") {
      const reset = db.prepare(
        "UPDATE platform_repositories SET protocol_initialized=0,protocol_state='uninitialized'," +
          "protocol_error=NULL,updated_at=datetime('now') WHERE id=?",
      );
      for (const repository of task.repositories) reset.run(repository.id);
    }
  })();
  return task;
}

export function updatePlatformTaskStatus(db: DB, key: string, status: unknown): PlatformTask | undefined {
  if (!PLATFORM_TASK_STATUSES.includes(status as PlatformTaskStatus)) {
    throw new PlatformValidationError("Task 状态无效");
  }
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  if (task.status === status) return task;

  if (task.task_type === "repository_init" && status === "review") {
    const editable = task.repositories.find((repository) => repository.mode === "editable");
    const hasSharedOverview = task.artifacts.some(
      (artifact) => artifact.kind === "doc" && artifact.path === ".alignyard/docs/shared/overview.md",
    );
    if (!editable || editable.manifest_status !== "valid" || !hasSharedOverview) {
      throw new PlatformValidationError(
        "初始化 Task 需要先完成 ay validate、ay sync，并提供 .alignyard/docs/shared/overview.md",
      );
    }
  }

  if (status === "completed") {
    if (task.pr_state !== "merged") {
      throw new PlatformValidationError("Task 只有在合并请求已合入后才能完成");
    }
    if (task.task_type === "repository_init") {
      const editable = task.repositories.find((repository) => repository.mode === "editable");
      if (editable?.protocol_state !== "ready") {
        throw new PlatformValidationError("初始化 Task 只有在 Repository 就绪后才能完成");
      }
    }
  }

  const transitions: Record<PlatformTaskStatus, readonly PlatformTaskStatus[]> = {
    draft: ["review"],
    review: ["draft", "approved"],
    approved: task.task_type === "repository_init" && task.pr_state === "open" ? ["draft", "completed"] : ["completed"],
    completed: [],
  };
  if (!transitions[task.status].includes(status as PlatformTaskStatus)) {
    throw new PlatformValidationError(`Task 不能从 ${task.status} 变为 ${status}`);
  }
  const changed = db.prepare(
    "UPDATE platform_tasks SET status=?,completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,datetime('now')) ELSE completed_at END," +
      "updated_at=datetime('now') WHERE task_key=?",
  ).run(status, status, key.toUpperCase()).changes;
  if (changed && task.task_type === "repository_init" && status === "draft") {
    db.prepare(
      "UPDATE platform_task_repositories SET manifest_status='waiting' WHERE task_id=? AND mode='editable'",
    ).run(task.id);
  }
  return changed ? getPlatformTask(db, key) : undefined;
}

export function listPlatformArtifacts(db: DB): PlatformArtifact[] {
  return db.prepare(
    "SELECT a.id,a.task_id,a.repository_id,r.name AS repository_name,t.task_key," +
      "a.kind,a.path,a.title,a.change_kind,a.review_status,a.base_commit,a.head_commit,a.updated_at " +
      "FROM platform_artifacts a " +
      "JOIN platform_repositories r ON r.id=a.repository_id " +
      "JOIN platform_tasks t ON t.id=a.task_id " +
      "ORDER BY a.updated_at DESC,a.id DESC",
  ).all() as PlatformArtifact[];
}

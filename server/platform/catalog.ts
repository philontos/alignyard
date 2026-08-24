import type Database from "better-sqlite3";

type DB = Database.Database;

export const PLATFORM_TASK_STATUSES = [
  "draft",
  "review",
  "approved",
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
  default_branch: string;
  protocol_initialized: boolean;
  protocol_state: RepositoryProtocolState;
  protocol_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

type PlatformRepositoryRow = Omit<PlatformRepository, "protocol_initialized"> & { protocol_initialized: number };

function shapeRepository(row: PlatformRepositoryRow): PlatformRepository {
  return { ...row, protocol_initialized: row.protocol_initialized === 1 };
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
  task_type: PlatformTaskType;
  status: PlatformTaskStatus;
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
  created_at: string;
  updated_at: string;
  repositories: PlatformTaskRepository[];
  artifacts: PlatformArtifact[];
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

function branchSlug(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "member";
}

export function listPlatformRepositories(db: DB): PlatformRepository[] {
  const rows = db.prepare(
    "SELECT id,name,git_url,default_branch,protocol_initialized,protocol_state,protocol_error," +
      "created_by,created_at,updated_at " +
      "FROM platform_repositories ORDER BY updated_at DESC,id DESC",
  ).all() as PlatformRepositoryRow[];
  return rows.map(shapeRepository);
}

export function getPlatformRepository(db: DB, id: number): PlatformRepository | undefined {
  const row = db.prepare(
    "SELECT id,name,git_url,default_branch,protocol_initialized,protocol_state,protocol_error," +
      "created_by,created_at,updated_at " +
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
  const gitUrl = requiredText(input.git_url, "Git 地址");
  const defaultBranch = typeof input.default_branch === "string" && input.default_branch.trim()
    ? input.default_branch.trim()
    : "main";
  const createdBy = typeof input.created_by === "string" && input.created_by.trim()
    ? input.created_by.trim()
    : "当前用户";

  try {
    const result = db.prepare(
      "INSERT INTO platform_repositories (name,git_url,default_branch,created_by) VALUES (?,?,?,?)",
    ).run(name, gitUrl, defaultBranch, createdBy);
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

type TaskRow = Omit<PlatformTask, "key" | "repositories" | "artifacts"> & { task_key: string };

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
      "r.created_by,r.created_at,r.updated_at," +
      "tr.mode,tr.base_branch,tr.base_commit,tr.work_branch,tr.head_commit,tr.assignee," +
      "tr.manifest_status,tr.last_reported_at " +
      "FROM platform_task_repositories tr " +
      "JOIN platform_repositories r ON r.id=tr.repository_id " +
      "WHERE tr.task_id=? ORDER BY CASE tr.mode WHEN 'editable' THEN 0 ELSE 1 END,r.name",
  ).all(taskId) as (Omit<PlatformTaskRepository, "protocol_initialized"> & { protocol_initialized: number })[];
  return rows.map((row) => ({ ...row, protocol_initialized: row.protocol_initialized === 1 }));
}

function shapeTask(db: DB, row: TaskRow): PlatformTask {
  return {
    id: row.id,
    key: row.task_key,
    title: row.title,
    description: row.description,
    owner: row.owner,
    task_type: row.task_type,
    status: row.status,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    repositories: repositoriesForTask(db, row.id),
    artifacts: artifactsForTask(db, row.id),
  };
}

export function listPlatformTasks(db: DB): PlatformTask[] {
  const rows = db.prepare(
    "SELECT pt.id,pt.task_key,pt.title,pt.description,pt.owner,pt.task_type,pt.status," +
      "pt.runtime_task_id,rt.status AS runtime_status,rt.error AS runtime_error," +
      "rt.worktree_path AS runtime_worktree,rt.session AS runtime_session,rt.agent AS runtime_agent," +
      "pt.workflow_error,pt.pr_number,pt.pr_url,pt.pr_state,pt.merged_at,pt.created_at,pt.updated_at " +
      "FROM platform_tasks pt LEFT JOIN tasks rt ON rt.id=pt.runtime_task_id " +
      "ORDER BY pt.updated_at DESC,pt.id DESC",
  ).all() as TaskRow[];
  return rows.map((row) => shapeTask(db, row));
}

export function getPlatformTask(db: DB, key: string): PlatformTask | undefined {
  const row = db.prepare(
    "SELECT pt.id,pt.task_key,pt.title,pt.description,pt.owner,pt.task_type,pt.status," +
      "pt.runtime_task_id,rt.status AS runtime_status,rt.error AS runtime_error," +
      "rt.worktree_path AS runtime_worktree,rt.session AS runtime_session,rt.agent AS runtime_agent," +
      "pt.workflow_error,pt.pr_number,pt.pr_url,pt.pr_state,pt.merged_at,pt.created_at,pt.updated_at " +
      "FROM platform_tasks pt LEFT JOIN tasks rt ON rt.id=pt.runtime_task_id WHERE pt.task_key=?",
  ).get(key.toUpperCase()) as TaskRow | undefined;
  return row ? shapeTask(db, row) : undefined;
}

export function linkPlatformTaskRuntime(
  db: DB,
  key: string,
  runtime: { id: number; work_branch: string; base_commit: string | null },
): PlatformTask | undefined {
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  db.transaction(() => {
    db.prepare(
      "UPDATE platform_tasks SET runtime_task_id=?,workflow_error=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(runtime.id, task.id);
    db.prepare(
      "UPDATE platform_task_repositories SET work_branch=?,base_commit=COALESCE(?,base_commit) " +
        "WHERE task_id=? AND mode='editable'",
    ).run(runtime.work_branch, runtime.base_commit, task.id);
  })();
  return getPlatformTask(db, key);
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
      "INSERT INTO platform_tasks (task_key,title,description,owner,task_type) VALUES (?,?,?,?,?)",
    ).run(`pending-${Date.now()}-${Math.random()}`, title, description, owner, taskType);
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
): PlatformTask {
  const repository = getPlatformRepository(db, repositoryId);
  if (!repository) throw new PlatformValidationError("Repository 不存在");
  if (repository.protocol_state === "ready") throw new PlatformValidationError("Repository 已完成初始化");

  const existing = db.prepare(
    "SELECT t.task_key FROM platform_tasks t " +
      "JOIN platform_task_repositories tr ON tr.task_id=t.id " +
      "WHERE tr.repository_id=? AND t.task_type='repository_init' " +
      "AND t.status IN ('draft','review') ORDER BY t.id DESC LIMIT 1",
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
      "梳理 scopes 与最小基础 Docs，运行 ay validate、ay sync，提交 Review 后合并到默认分支。",
    owner,
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

  const transitions: Record<PlatformTaskStatus, readonly PlatformTaskStatus[]> = {
    draft: ["review"],
    review: ["draft", "approved"],
    approved: [],
  };
  if (!transitions[task.status].includes(status as PlatformTaskStatus)) {
    throw new PlatformValidationError(`Task 不能从 ${task.status} 变为 ${status}`);
  }
  const changed = db.prepare(
    "UPDATE platform_tasks SET status=?,updated_at=datetime('now') WHERE task_key=?",
  ).run(status, key.toUpperCase()).changes;
  if (changed && task.task_type === "repository_init" && task.status === "review" && status === "draft") {
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

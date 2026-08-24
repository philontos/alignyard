import type Database from "better-sqlite3";

type DB = Database.Database;

export const PLATFORM_TASK_STATUSES = [
  "draft",
  "review",
  "approved",
] as const;

export type PlatformTaskStatus = typeof PLATFORM_TASK_STATUSES[number];
export type RepositoryMode = "editable" | "reference";

export interface PlatformRepository {
  id: number;
  name: string;
  git_url: string;
  default_branch: string;
  protocol_initialized: boolean;
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
  status: PlatformTaskStatus;
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
    "SELECT id,name,git_url,default_branch,protocol_initialized,created_by,created_at,updated_at " +
      "FROM platform_repositories ORDER BY updated_at DESC,id DESC",
  ).all() as PlatformRepositoryRow[];
  return rows.map(shapeRepository);
}

export function getPlatformRepository(db: DB, id: number): PlatformRepository | undefined {
  const row = db.prepare(
    "SELECT id,name,git_url,default_branch,protocol_initialized,created_by,created_at,updated_at " +
      "FROM platform_repositories WHERE id=?",
  ).get(id) as PlatformRepositoryRow | undefined;
  return row ? shapeRepository(row) : undefined;
}

export function setPlatformRepositoryProtocolInitialized(
  db: DB,
  id: number,
  initialized: boolean,
): PlatformRepository | undefined {
  const changed = db.prepare(
    "UPDATE platform_repositories SET protocol_initialized=?,updated_at=datetime('now') WHERE id=?",
  ).run(initialized ? 1 : 0, id).changes;
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
    "SELECT r.id,r.name,r.git_url,r.default_branch,r.protocol_initialized,r.created_by,r.created_at,r.updated_at," +
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
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    repositories: repositoriesForTask(db, row.id),
    artifacts: artifactsForTask(db, row.id),
  };
}

export function listPlatformTasks(db: DB): PlatformTask[] {
  const rows = db.prepare(
    "SELECT id,task_key,title,description,owner,status,created_at,updated_at " +
      "FROM platform_tasks ORDER BY updated_at DESC,id DESC",
  ).all() as TaskRow[];
  return rows.map((row) => shapeTask(db, row));
}

export function getPlatformTask(db: DB, key: string): PlatformTask | undefined {
  const row = db.prepare(
    "SELECT id,task_key,title,description,owner,status,created_at,updated_at " +
      "FROM platform_tasks WHERE task_key=?",
  ).get(key.toUpperCase()) as TaskRow | undefined;
  return row ? shapeTask(db, row) : undefined;
}

export function createPlatformTask(db: DB, input: Record<string, unknown>): PlatformTask {
  const title = requiredText(input.title, "Task 标题");
  const owner = requiredText(input.owner, "负责人");
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
      "INSERT INTO platform_tasks (task_key,title,description,owner) VALUES (?,?,?,?)",
    ).run(`pending-${Date.now()}-${Math.random()}`, title, description, owner);
    const taskId = Number(taskInfo.lastInsertRowid);
    const key = `AY-${String(taskId).padStart(3, "0")}`;
    db.prepare("UPDATE platform_tasks SET task_key=? WHERE id=?").run(key, taskId);

    const repoQuery = db.prepare("SELECT id,default_branch FROM platform_repositories WHERE id=?");
    const insert = db.prepare(
      "INSERT INTO platform_task_repositories " +
        "(task_id,repository_id,mode,base_branch,work_branch,assignee) VALUES (?,?,?,?,?,?)",
    );
    for (const item of normalized) {
      const repository = repoQuery.get(item.repository_id) as { id: number; default_branch: string } | undefined;
      if (!repository) throw new PlatformValidationError(`Repository #${item.repository_id} 不存在`);
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
    return key;
  });

  const task = getPlatformTask(db, create());
  if (!task) throw new Error("Task 创建后未找到");
  return task;
}

export function updatePlatformTaskStatus(db: DB, key: string, status: unknown): PlatformTask | undefined {
  if (!PLATFORM_TASK_STATUSES.includes(status as PlatformTaskStatus)) {
    throw new PlatformValidationError("Task 状态无效");
  }
  const task = getPlatformTask(db, key);
  if (!task) return undefined;
  if (task.status === status) return task;

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

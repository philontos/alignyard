import crypto from "node:crypto";
import type Database from "better-sqlite3";
import YAML from "yaml";
import {
  KNOWLEDGE_KINDS,
  knowledgeDirectory,
  parseRepositoryManifest,
  type KnowledgeKind,
} from "../protocol/repository.js";
import { getPlatformTask, type PlatformTask } from "./catalog.js";

type DB = Database.Database;

const MAX_DOCUMENTS = 500;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const CHANGE_KINDS = new Set(["snapshot", "added", "modified", "unchanged"]);
const HAN_CHARACTER = /\p{Script=Han}/u;

export class PlatformSyncError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlatformSyncError";
  }
}

interface SyncDocument {
  id: string;
  kind: KnowledgeKind;
  scope: string;
  title: string;
  path: string;
  owners: string[];
  relations: string[];
  content: string;
  content_hash: string;
  change_kind: string;
}

function requiredString(value: unknown, label: string, max = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new PlatformSyncError(400, `${label}不能为空`);
  if (text.length > max) throw new PlatformSyncError(400, `${label}过长`);
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new PlatformSyncError(400, `${label}必须是非空字符串数组`);
  }
  const result = value.map((item) => String(item).trim());
  if (new Set(result).size !== result.length) throw new PlatformSyncError(400, `${label}不能包含重复项`);
  return result;
}

function frontmatter(content: string, filePath: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new PlatformSyncError(400, `${filePath}: 缺少 YAML frontmatter`);
  try {
    const metadata = YAML.parse(match[1]);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("frontmatter 必须是对象");
    return metadata as Record<string, unknown>;
  } catch (error: any) {
    throw new PlatformSyncError(400, `${filePath}: ${String(error?.message || error)}`);
  }
}

function normalizeDocument(raw: unknown, scopes: Set<string>): SyncDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlatformSyncError(400, "document 必须是对象");
  const value = raw as Record<string, unknown>;
  const id = requiredString(value.id, "document.id");
  const kind = requiredString(value.kind, `${id}.kind`) as KnowledgeKind;
  if (!KNOWLEDGE_KINDS.includes(kind)) throw new PlatformSyncError(400, `${id}.kind 无效`);
  const scope = requiredString(value.scope, `${id}.scope`);
  if (!scopes.has(scope)) throw new PlatformSyncError(400, `${id}.scope 未在 manifest 中声明`);
  const title = requiredString(value.title, `${id}.title`);
  const filePath = requiredString(value.path, `${id}.path`, 1000);
  const expectedPrefix = `.alignyard/${knowledgeDirectory(kind)}/${scope}/`;
  if (!filePath.startsWith(expectedPrefix) || !filePath.endsWith(".md") || filePath.includes("..") || filePath.includes("\\")) {
    throw new PlatformSyncError(400, `${id}.path 必须位于 ${expectedPrefix}`);
  }
  const owners = stringArray(value.owners ?? [], `${id}.owners`);
  const relations = stringArray(value.relations ?? [], `${id}.relations`);
  const content = typeof value.content === "string" ? value.content : "";
  const bytes = Buffer.byteLength(content);
  if (!content) throw new PlatformSyncError(400, `${id}.content 不能为空`);
  if (bytes > MAX_DOCUMENT_BYTES) throw new PlatformSyncError(413, `${filePath} 超过 1 MiB`);
  const contentHash = requiredString(value.content_hash, `${id}.content_hash`, 64);
  const actualHash = crypto.createHash("sha256").update(content).digest("hex");
  if (contentHash !== actualHash) throw new PlatformSyncError(400, `${id}.content_hash 不匹配`);
  const changeKind = requiredString(value.change_kind, `${id}.change_kind`);
  if (!CHANGE_KINDS.has(changeKind)) throw new PlatformSyncError(400, `${id}.change_kind 无效`);

  const metadata = frontmatter(content, filePath);
  for (const [field, expected] of Object.entries({ id, kind, scope, title })) {
    if (metadata[field] !== expected) throw new PlatformSyncError(400, `${filePath}: frontmatter.${field} 与索引不一致`);
  }
  if (JSON.stringify(metadata.owners ?? []) !== JSON.stringify(owners)) {
    throw new PlatformSyncError(400, `${filePath}: frontmatter.owners 与索引不一致`);
  }
  if (JSON.stringify(metadata.relations ?? []) !== JSON.stringify(relations)) {
    throw new PlatformSyncError(400, `${filePath}: frontmatter.relations 与索引不一致`);
  }
  return { id, kind, scope, title, path: filePath, owners, relations, content, content_hash: contentHash, change_kind: changeKind };
}

function assertChineseInitializationDocument(document: SyncDocument): void {
  const body = document.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  if (!HAN_CHARACTER.test(document.title)) {
    throw new PlatformSyncError(400, `${document.path}: 初始化工程知识的 title 必须使用中文`);
  }
  if (!HAN_CHARACTER.test(body)) {
    throw new PlatformSyncError(400, `${document.path}: 初始化工程知识的正文必须使用中文`);
  }
  const nonChineseHeading = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .find((heading) => !HAN_CHARACTER.test(heading));
  if (nonChineseHeading) {
    throw new PlatformSyncError(400, `${document.path}: 章节标题「${nonChineseHeading}」必须使用中文`);
  }
}

export function syncPlatformTaskKnowledge(
  db: DB,
  taskKey: string,
  input: Record<string, unknown>,
): { task: PlatformTask; documents: number } {
  const task = getPlatformTask(db, taskKey);
  if (!task) throw new PlatformSyncError(404, "Task 不存在");
  if (task.status === "approved") throw new PlatformSyncError(409, "Approved Task 不能再同步文档");

  const repositoryId = Number(input.repository_id);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) throw new PlatformSyncError(400, "repository_id 无效");
  const taskRepository = task.repositories.find((repository) => repository.id === repositoryId);
  if (!taskRepository) throw new PlatformSyncError(404, "Task 未关联这个 Repository");
  if (taskRepository.mode !== "editable") throw new PlatformSyncError(409, "只读 Repository 不能同步文档变更");

  const parsedManifest = parseRepositoryManifest(JSON.stringify(input.manifest));
  if (!parsedManifest.manifest) throw new PlatformSyncError(400, parsedManifest.errors.join("\n"));
  if (!Array.isArray(input.documents)) throw new PlatformSyncError(400, "documents 必须是数组");
  if (input.documents.length > MAX_DOCUMENTS) throw new PlatformSyncError(413, `documents 不能超过 ${MAX_DOCUMENTS} 个`);
  const scopes = new Set(parsedManifest.manifest.scopes.map((scope) => scope.id));
  const documents = input.documents.map((document) => normalizeDocument(document, scopes));
  if (task.task_type === "repository_init" && !documents.some((document) =>
    document.kind === "doc" && document.path === ".alignyard/docs/shared/overview.md"
  )) {
    throw new PlatformSyncError(400, "初始化 Task 必须包含 .alignyard/docs/shared/overview.md");
  }
  if (task.task_type === "repository_init") {
    for (const document of documents) assertChineseInitializationDocument(document);
  }
  const totalBytes = documents.reduce((sum, document) => sum + Buffer.byteLength(document.content), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new PlatformSyncError(413, "文档总大小超过 8 MiB");

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) throw new PlatformSyncError(400, `document.id「${document.id}」重复`);
    if (paths.has(document.path)) throw new PlatformSyncError(400, `document.path「${document.path}」重复`);
    ids.add(document.id);
    paths.add(document.path);
  }
  for (const document of documents) {
    for (const relation of document.relations) {
      if (!ids.has(relation)) throw new PlatformSyncError(400, `${document.id}.relations 指向不存在的 ${relation}`);
    }
  }

  const baseCommit = typeof input.base_commit === "string" && input.base_commit.trim() ? input.base_commit.trim() : null;
  const headCommit = typeof input.head_commit === "string" && input.head_commit.trim() ? input.head_commit.trim() : null;
  db.transaction(() => {
    const upsert = db.prepare(
      "INSERT INTO platform_artifacts " +
        "(task_id,repository_id,document_id,kind,scope,path,title,owners,relations,content,content_hash,change_kind,base_commit,head_commit) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(task_id,repository_id,path) DO UPDATE SET " +
        "document_id=excluded.document_id,kind=excluded.kind,scope=excluded.scope,title=excluded.title," +
        "owners=excluded.owners,relations=excluded.relations,content=excluded.content," +
        "review_status=CASE WHEN platform_artifacts.content_hash=excluded.content_hash THEN platform_artifacts.review_status ELSE 'unreviewed' END," +
        "content_hash=excluded.content_hash,change_kind=excluded.change_kind,base_commit=excluded.base_commit," +
        "head_commit=excluded.head_commit,updated_at=datetime('now')",
    );
    for (const document of documents) {
      upsert.run(
        task.id,
        repositoryId,
        document.id,
        document.kind,
        document.scope,
        document.path,
        document.title,
        JSON.stringify(document.owners),
        JSON.stringify(document.relations),
        document.content,
        document.content_hash,
        document.change_kind,
        baseCommit,
        headCommit,
      );
    }
    const existing = db.prepare(
      "SELECT path FROM platform_artifacts WHERE task_id=? AND repository_id=?",
    ).all(task.id, repositoryId) as { path: string }[];
    const remove = db.prepare("DELETE FROM platform_artifacts WHERE task_id=? AND repository_id=? AND path=?");
    for (const row of existing) if (!paths.has(row.path)) remove.run(task.id, repositoryId, row.path);

    db.prepare(
      "UPDATE platform_task_repositories SET base_commit=COALESCE(?,base_commit),head_commit=?," +
        "manifest_status='valid',last_reported_at=datetime('now') WHERE task_id=? AND repository_id=?",
    ).run(baseCommit, headCommit, task.id, repositoryId);
    db.prepare("UPDATE platform_tasks SET updated_at=datetime('now') WHERE id=?").run(task.id);
  })();

  const updated = getPlatformTask(db, task.key);
  if (!updated) throw new Error("Task 同步后未找到");
  return { task: updated, documents: documents.length };
}

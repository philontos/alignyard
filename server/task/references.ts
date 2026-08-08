import type Database from "better-sqlite3";
import path from "node:path";
import type { Repo, TaskReference } from "../core/db.js";
import { getOwnedRepo } from "../core/ownership.js";

type DB = Database.Database;

export interface TaskReferenceInput {
  repo_id: number;
  ref?: string | null;
  branch?: string | null;
  alias?: string | null;
}

export interface ResolvedReferenceInput {
  repo: Repo & { mirror_path: string };
  alias: string;
  requested_ref: string;
}

export interface TaskReferenceRecord extends TaskReference {
  repo_name: string;
  mirror_path: string | null;
}

export type ResolveReferencesResult =
  | { ok: true; references: ResolvedReferenceInput[] }
  | { ok: false; error: string };

function aliasSlug(value: string, repoId: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
  return slug || `repo-${repoId}`;
}

function uniqueAlias(seed: string, used: Set<string>): string {
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = seed.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("could not create a unique repository reference alias");
}

// Equivalent to the safety-relevant `git check-ref-format --branch` rules. The
// selected value is a branch name (not an arbitrary revision expression) and is
// later interpolated into a fetch refspec, so reject ref metacharacters here.
function isBranchName(value: string): boolean {
  if (!value || value.length > 255 || value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  if (value.includes("..") || value.includes("@{") || value.includes("//") || value.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  return !value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
}

/** Resolve client-supplied repo ids against this node's own catalog. Paths and
 * mirror coordinates are never accepted from the client. */
export function resolveReferenceInputs(db: DB, raw: unknown): ResolveReferencesResult {
  if (raw == null) return { ok: true, references: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "references must be an array" };
  if (raw.length > 8) return { ok: false, error: "a task can reference at most 8 repositories" };

  const used = new Set<string>();
  const references: ResolvedReferenceInput[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") return { ok: false, error: "invalid repository reference" };
    const input = value as TaskReferenceInput;
    const repoId = Number(input.repo_id);
    if (!Number.isInteger(repoId) || repoId <= 0) return { ok: false, error: "invalid reference repository" };
    const repo = getOwnedRepo(db, repoId);
    if (!repo?.mirror_path) return { ok: false, error: `reference repository ${repoId} was not found on this node` };
    if (repo.status !== "ready") return { ok: false, error: `reference repository ${repo.name} is ${repo.status}` };

    const requestedRef = String(input.ref ?? input.branch ?? repo.default_branch ?? "").trim();
    if (!isBranchName(requestedRef)) {
      return { ok: false, error: `invalid reference branch for ${repo.name}` };
    }
    const seed = aliasSlug(String(input.alias || repo.name), repo.id);
    references.push({
      repo: repo as Repo & { mirror_path: string },
      alias: uniqueAlias(seed, used),
      requested_ref: requestedRef,
    });
  }
  return { ok: true, references };
}

export function listTaskReferences(db: DB, taskId: number): TaskReferenceRecord[] {
  return db.prepare(
    "SELECT tr.*, r.name AS repo_name, r.mirror_path AS mirror_path " +
      "FROM task_references tr LEFT JOIN repos r ON r.id=tr.repo_id " +
      "WHERE tr.task_id=? ORDER BY tr.alias",
  ).all(taskId) as TaskReferenceRecord[];
}

export function referenceWorktreePaths(db: DB, taskId: number): string[] {
  return listTaskReferences(db, taskId).map((reference) => reference.worktree_path).filter(Boolean);
}

export function referenceRootPath(dataDir: string, taskId: number): string {
  return path.join(dataDir, "worktrees", "refs", String(taskId));
}

export function removeTaskReferenceRows(db: DB, taskId: number): void {
  db.prepare("DELETE FROM task_references WHERE task_id=?").run(taskId);
}

export function referencePrompt(
  primary: { name: string; path: string },
  references: Array<Pick<TaskReferenceRecord, "alias" | "repo_name" | "requested_ref" | "resolved_commit" | "worktree_path">>,
  userPrompt?: string | null,
): string | null {
  if (!references.length) return userPrompt?.trim() ? userPrompt : null;
  const lines = [
    "Switchyard workspace:",
    `- Primary repository (editable): ${primary.name} at ${primary.path}`,
    ...references.map((reference) =>
      `- ref:${reference.alias} (reference-only): ${reference.repo_name}/${reference.requested_ref}` +
      `@${reference.resolved_commit.slice(0, 12)} at ${reference.worktree_path}`,
    ),
    "Treat reference worktrees as read-only unless the user explicitly asks to modify them.",
    "Before relying on a reference repository, inspect its repository-local agent instructions.",
  ];
  if (userPrompt?.trim()) lines.push("", "User task:", userPrompt);
  return lines.join("\n");
}

export function publicTaskReferences(db: DB, taskId: number) {
  return listTaskReferences(db, taskId).map(({ mirror_path: _mirror, worktree_path: _path, ...reference }) => reference);
}

// Runtime repository-reference attachment. Unlike dispatch-time references,
// this operates on an existing task: materialize one pinned detached worktree,
// persist it in the task manifest, then ask the task's current agent adapter to
// make the new directory available without creating a new conversation.
import path from "node:path";
import type Database from "better-sqlite3";
import type { Task } from "../core/db.js";
import { getOwnedTask } from "../core/ownership.js";
import {
  listTaskReferences,
  publicTaskReferences,
  referenceRootPath,
  referenceWorktreePaths,
  resolveReferenceInputs,
  type TaskReferenceInput,
} from "./references.js";

type DB = Database.Database;

export type RuntimeReferenceLoad = "in-place" | "resumed" | "deferred";

export interface AddTaskReferenceEnv {
  db: DB;
  dataDir: string;
  exists(target: string): Promise<boolean>;
  setupReference(args: {
    mirror: string;
    worktree: string;
    requestedRef: string;
  }): Promise<string>;
  removeReference(mirror: string, worktree: string): Promise<void>;
  writeManifest(taskId: number): void | Promise<void>;
  loadReference(
    task: Task,
    newReferencePath: string,
    allReferencePaths: string[],
  ): Promise<RuntimeReferenceLoad>;
}

export type AddTaskReferenceResult =
  | {
      ok: true;
      reference: ReturnType<typeof publicTaskReferences>[number];
      load: RuntimeReferenceLoad | "already";
      existing: boolean;
      warning?: string;
    }
  | {
      ok: false;
      error: "notFound" | "notRepoTask" | "notReady" | "invalidReference" | "limit" | "materializeFailed" | "persistFailed";
      message: string;
    };

/** Attach one repository snapshot to an owner-local task. The reference is
 * durable before the session is touched: if an agent reload fails, Resume can
 * still pick up every recorded --add-dir on the next launch. */
export async function addTaskReference(
  env: AddTaskReferenceEnv,
  taskId: number,
  input: TaskReferenceInput,
): Promise<AddTaskReferenceResult> {
  const task = getOwnedTask(env.db, taskId);
  if (!task) return { ok: false, error: "notFound", message: "Task not found on this node" };
  if (task.kind === "local") {
    return { ok: false, error: "notRepoTask", message: "Repository references require a repository task" };
  }
  if (!task.worktree_path || !(await env.exists(task.worktree_path).catch(() => false))) {
    return { ok: false, error: "notReady", message: "The task worktree is not available" };
  }

  const existing = listTaskReferences(env.db, task.id);
  const resolved = resolveReferenceInputs(env.db, [input], existing.map((reference) => reference.alias));
  if (!resolved.ok) return { ok: false, error: "invalidReference", message: resolved.error };
  const selected = resolved.references[0];
  if (!selected || selected.repo.id === task.repo_id) {
    return { ok: false, error: "invalidReference", message: "The primary repository cannot also be a task reference" };
  }
  const duplicate = existing.find((reference) =>
    reference.repo_id === selected.repo.id && reference.requested_ref === selected.requested_ref,
  );
  if (duplicate) {
    const reference = publicTaskReferences(env.db, task.id).find((candidate) => candidate.alias === duplicate.alias)!;
    return { ok: true, reference, load: "already", existing: true };
  }
  if (existing.length >= 8) {
    return { ok: false, error: "limit", message: "A task can reference at most 8 repositories" };
  }

  const worktree = path.join(referenceRootPath(env.dataDir, task.id), selected.alias);
  let commit: string;
  try {
    commit = await env.setupReference({
      mirror: selected.repo.mirror_path,
      worktree,
      requestedRef: selected.requested_ref,
    });
  } catch {
    await env.removeReference(selected.repo.mirror_path, worktree).catch(() => {});
    return {
      ok: false,
      error: "materializeFailed",
      message: `Could not prepare ${selected.repo.name}/${selected.requested_ref}`,
    };
  }

  let inserted = false;
  try {
    env.db.prepare(
      "INSERT INTO task_references " +
        "(task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path,mode) VALUES (?,?,?,?,?,?, 'reference')",
    ).run(task.id, selected.repo.id, selected.alias, selected.requested_ref, commit, worktree);
    inserted = true;
    await env.writeManifest(task.id);
  } catch {
    if (inserted) env.db.prepare("DELETE FROM task_references WHERE task_id=? AND alias=?").run(task.id, selected.alias);
    await env.removeReference(selected.repo.mirror_path, worktree).catch(() => {});
    try { await env.writeManifest(task.id); } catch {}
    return { ok: false, error: "persistFailed", message: "Could not save the repository reference" };
  }

  let load: RuntimeReferenceLoad = "deferred";
  let warning: string | undefined;
  try {
    load = await env.loadReference(task, worktree, referenceWorktreePaths(env.db, task.id));
  } catch {
    // Do not roll back a valid, durable checkout because an interactive agent
    // happened to exit while it was being loaded. A later Resume includes it.
    warning = "The reference was saved and will be loaded when the task is resumed";
  }
  const reference = publicTaskReferences(env.db, task.id).find((candidate) => candidate.alias === selected.alias)!;
  return { ok: true, reference, load, existing: false, ...(warning ? { warning } : {}) };
}

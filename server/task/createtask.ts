// Runner-local task creation. Transport stays outside this module; filesystem,
// database and durable manifest changes form one explicit state machine here.
import path from "node:path";
import type { AgentKind } from "../session/agent.js";
import type Database from "better-sqlite3";
import { getOwnedTask } from "../core/ownership.js";
import {
  referencePrompt,
  resolveReferenceInputs,
  type TaskReferenceInput,
} from "./references.js";

type DB = Database.Database;

// tmux/branch-safe short id — same shape as index.ts's slug(). Kept local so the
// core doesn't drag in the HTTP server; fold into a shared util if a 3rd caller appears.
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "task";
}

// ---------- stop ----------
export interface StopTaskEnv {
  db: DB;
  killSession(session: string): Promise<void>;
  writeManifest(id: number): void | Promise<void>;
}

export type StopResult = { ok: true } | { ok: false; error: "notFound" };

/**
 * Stop one of THIS node's tasks: kill its tmux session, mark it cleaned, and
 * re-write the manifest so the durable record reflects the stop. The Runner
 * executes it locally and keeps the worktree.
 */
export async function stopTask(env: StopTaskEnv, id: number): Promise<StopResult> {
  const task = getOwnedTask(env.db, id);
  if (!task) return { ok: false, error: "notFound" };
  await env.killSession(task.session);
  env.db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id);
  await env.writeManifest(id);
  return { ok: true };
}

// ---------- repo task ----------
// The repo this task springs from. The owner already holds its mirror; the core
// derives the worktree path from it. (Not the full Repo row — just what we need.)
export interface RepoRef {
  id: number;
  name: string;
  mirror_path: string;
}

export interface RepoTaskEnv {
  db: DB;
  ns: string;
  // Persist the task's durable record. Both the CLI verb and HTTP route execute
  // on the owner and inject their node-local manifest writer.
  writeManifest(id: number): void | Promise<void>;
  // Prepare the worktree's contents: create it from the base branch and inject
  // the per-task Claude hooks. Grouped as one seam so orchestration remains
  // independent of git and filesystem mechanics.
  setupWorktree(args: {
    id: number;
    mirror: string;
    worktree: string;
    workBranch: string;
    baseBranch: string;
    agent: AgentKind;
  }): Promise<string>; // exact HEAD immediately after worktree creation
  // Create a detached, commit-pinned checkout for one referenced repository.
  setupReference(args: {
    mirror: string;
    worktree: string;
    requestedRef: string;
  }): Promise<string>;
  // Launch the agent in the worktree (opening = freeform prompt or null).
  // opts.env injects ANTHROPIC_* vars for claude's alternate model backend;
  // opts.agent picks the CLI (claude default | codex | kimi); opts.model is the
  // non-Claude -m model. All omitted → the machine's default claude login.
  startSession(
    session: string,
    worktree: string,
    opening: string | null,
    opts?: {
      env?: Record<string, string>;
      agent?: AgentKind;
      model?: string | null;
      addDirs?: string[];
      automated?: boolean;
    },
  ): Promise<void>;
  // Tear down a partially-built worktree after a failed dispatch.
  removeWorktree(mirror: string, worktree: string, workBranch: string): Promise<void>;
  removeReference(mirror: string, worktree: string): Promise<void>;
  removeReferenceRoot(taskId: number): Promise<void>;
}

export interface CreateRepoOpts {
  baseBranch: string;
  title: string;
  /** Optional caller-owned branch name. Platform workflows use their stable
   * Task key; ordinary runtime dispatch keeps the historical feat/<id>-<slug>. */
  workBranch?: string | null;
  prompt?: string | null;
  // Bounded environment passed to the Agent process. Runner operations filter
  // caller input before reaching this interface.
  env?: Record<string, string>;
  // Which coding-agent CLI runs the task (claude default | codex | kimi) and the
  // optional non-Claude -m model. Recorded so resume rebuilds the same launch.
  agent?: AgentKind;
  model?: string | null;
  /** Run the initial agent prompt without interactive approval/trust gates. */
  automated?: boolean;
  references?: TaskReferenceInput[];
}

export type CreateRepoResult =
  | { ok: true; id: number; session: string; workBranch: string }
  | { ok: false; error: "invalidReference"; message: string }
  | { ok: false; error: "dispatchFailed"; id: number; message: string };

/**
 * Create a repo task ON the owner: insert the row, prepare the worktree +
 * session, then flip to running and write the manifest. A failure
 * after the row exists removes the partial worktree and marks the task errored
 * (still manifested). The Runner operation remains a thin caller.
 */
export async function createRepoTask(env: RepoTaskEnv, repo: RepoRef, opts: CreateRepoOpts): Promise<CreateRepoResult> {
  const agent = opts.agent ?? "claude";
  const resolvedReferences = resolveReferenceInputs(env.db, opts.references);
  if (!resolvedReferences.ok) {
    return { ok: false, error: "invalidReference", message: resolvedReferences.error };
  }
  if (resolvedReferences.references.some((reference) => reference.repo.id === repo.id)) {
    return { ok: false, error: "invalidReference", message: "the primary repository cannot also be a task reference" };
  }
  const info = env.db
    .prepare(
      "INSERT INTO tasks (repo_id, base_branch, work_branch, title, prompt, worktree_path, session, status, agent, agent_model) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(repo.id, opts.baseBranch, "", opts.title, opts.prompt || null, "", "", "creating", agent, opts.model ?? null);
  const id = Number(info.lastInsertRowid);
  const s = slug(opts.title);
  const requestedBranch = String(opts.workBranch || "").trim();
  if (requestedBranch && (
    requestedBranch.startsWith("-") || requestedBranch.endsWith("/") || requestedBranch.endsWith(".lock") ||
    requestedBranch.includes("..") || requestedBranch.includes("//") || /[\s~^:?*[\\]/.test(requestedBranch)
  )) {
    env.db.prepare("UPDATE tasks SET status='error',error=? WHERE id=?")
      .run("invalid work branch", id);
    await env.writeManifest(id);
    return { ok: false, error: "dispatchFailed", id, message: "invalid work branch" };
  }
  const workBranch = requestedBranch || `feat/${id}-${s}`;
  const worktree = path.resolve(path.join(path.dirname(repo.mirror_path), "..", "worktrees", `${repo.id}-${id}`));
  const referenceRoot = path.resolve(path.join(path.dirname(repo.mirror_path), "..", "worktrees", "refs", String(id)));
  const session = `ay-${env.ns}-${id}-${slug(repo.name)}-${s}`;
  const materialized: Array<{
    task_id: number;
    repo_id: number;
    alias: string;
    repo_name: string;
    mirror_path: string;
    requested_ref: string;
    resolved_commit: string;
    worktree_path: string;
    mode: "reference";
  }> = [];
  const referenceCleanup: Array<{ mirror: string; worktree: string }> = [];

  try {
    const baseCommit = await env.setupWorktree({ id, mirror: repo.mirror_path, worktree, workBranch, baseBranch: opts.baseBranch, agent });
    for (const reference of resolvedReferences.references) {
      const referenceWorktree = path.join(referenceRoot, reference.alias);
      referenceCleanup.push({ mirror: reference.repo.mirror_path, worktree: referenceWorktree });
      const commit = await env.setupReference({
        mirror: reference.repo.mirror_path,
        worktree: referenceWorktree,
        requestedRef: reference.requested_ref,
      });
      materialized.push({
        task_id: id,
        repo_id: reference.repo.id,
        alias: reference.alias,
        repo_name: reference.repo.name,
        mirror_path: reference.repo.mirror_path,
        requested_ref: reference.requested_ref,
        resolved_commit: commit,
        worktree_path: referenceWorktree,
        mode: "reference",
      });
    }
    if (materialized.length) {
      const insert = env.db.prepare(
        "INSERT INTO task_references " +
          "(task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path,mode) VALUES (?,?,?,?,?,?,?)",
      );
      env.db.transaction(() => {
        for (const reference of materialized) {
          insert.run(
            reference.task_id,
            reference.repo_id,
            reference.alias,
            reference.requested_ref,
            reference.resolved_commit,
            reference.worktree_path,
            reference.mode,
          );
        }
      })();
    }
    // Preserve the user's prompt verbatim in the task row. The launch-only
    // opening prepends a compact alias/path contract when references exist.
    const opening = referencePrompt(
      { name: repo.name, path: worktree },
      materialized,
      opts.prompt,
    );
    await env.startSession(session, worktree, opening, {
      env: opts.env,
      agent,
      model: opts.model,
      addDirs: materialized.map((reference) => reference.worktree_path),
      automated: opts.automated,
    });
    env.db.prepare("UPDATE tasks SET base_commit=?, work_branch=?, worktree_path=?, session=?, status='running' WHERE id=?")
      .run(baseCommit, workBranch, worktree, session, id);
    await env.writeManifest(id);
    return { ok: true, id, session, workBranch };
  } catch (e: any) {
    // a partial dispatch (e.g. session start failed after the worktree was made)
    // would orphan the worktree — remove it so nothing is left behind
    for (const reference of [...referenceCleanup].reverse()) {
      await env.removeReference(reference.mirror, reference.worktree).catch(() => {});
    }
    if (referenceCleanup.length) await env.removeReferenceRoot(id).catch(() => {});
    env.db.prepare("DELETE FROM task_references WHERE task_id=?").run(id);
    await env.removeWorktree(repo.mirror_path, worktree, workBranch).catch(() => {});
    env.db.prepare("UPDATE tasks SET status='error', error=? WHERE id=?").run(String(e?.message || e), id);
    await env.writeManifest(id);
    return { ok: false, error: "dispatchFailed", id, message: String(e?.message || e) };
  }
}

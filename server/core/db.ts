import Database from "better-sqlite3";
import fs from "node:fs";
import { DATA_DIR, DB_PATH, LEGACY_DATA_DIR, DID_MIGRATE, NS } from "./paths.js";
import { initSchema } from "./schema.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// create tables, reconcile columns onto older DBs, and run the one-time
// project-local data path rewrite only if we just moved the directory.
initSchema(db, { didMigrate: DID_MIGRATE, legacyDir: LEGACY_DATA_DIR, dataDir: DATA_DIR });

// Seed the local machine (kind='local', always present, machine #0) and make
// every repo belong to a machine — existing repos default to the local one.
{
  const local = db.prepare("SELECT id FROM hosts WHERE kind='local'").get() as { id: number } | undefined;
  let localId: number;
  if (local) {
    localId = local.id;
    db.prepare("UPDATE hosts SET data_dir=?, node_id=?, status='online' WHERE id=?").run(DATA_DIR, NS, localId);
  } else {
    const info = db.prepare(
      "INSERT INTO hosts (name, target, kind, data_dir, node_id, status) VALUES ('local','','local',?,?,'online')"
    ).run(DATA_DIR, NS);
    localId = Number(info.lastInsertRowid);
  }
  db.prepare("UPDATE repos SET host_id=? WHERE host_id IS NULL").run(localId);
}

export interface Repo {
  id: number;
  host_id: number;
  name: string;
  git_url: string;
  token: string | null;
  default_branch: string;
  mirror_path: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  repo_id: number;
  base_branch: string;
  base_commit: string | null;     // immutable task start point, for stable code diffs
  work_branch: string;
  title: string;
  prompt: string | null;
  worktree_path: string;
  session: string;
  status: string;
  error: string | null;
  created_at: string;
  kind: string;              // 'repo' | 'local'
  host_id: number | null;    // local tasks: the machine they run on
  cwd: string | null;        // local tasks: working dir
  agent: string;                   // which coding-agent CLI runs the task: claude | codex | kimi
  agent_model: string | null;      // codex/kimi: the -m model; NULL == the node's default model
}

export interface TaskReference {
  task_id: number;
  repo_id: number;
  alias: string;
  requested_ref: string;
  resolved_commit: string;
  worktree_path: string;
  mode: string;                    // currently always 'reference'
  created_at: string;
}

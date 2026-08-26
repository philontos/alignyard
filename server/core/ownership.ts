import type Database from "better-sqlite3";
import type { Repo, Task } from "./db.js";

type DB = Database.Database;

export function localHostId(db: DB): number | null {
  const row = db.prepare("SELECT id FROM hosts WHERE kind='local' LIMIT 1").get() as { id: number } | undefined;
  return row?.id ?? null;
}

export function listOwnedRepos(db: DB): Repo[] {
  const hostId = localHostId(db);
  if (hostId == null) return [];
  return db.prepare("SELECT * FROM repos WHERE host_id=? ORDER BY id DESC").all(hostId) as Repo[];
}

export function getOwnedRepo(db: DB, id: number | string): Repo | undefined {
  const hostId = localHostId(db);
  if (hostId == null) return undefined;
  return db.prepare("SELECT * FROM repos WHERE id=? AND host_id=?").get(id, hostId) as Repo | undefined;
}

export function listOwnedTasks(db: DB): Task[] {
  const hostId = localHostId(db);
  if (hostId == null) return [];
  return db.prepare(
    "SELECT t.* FROM tasks t WHERE " +
      "(t.kind='local' AND t.host_id=?) OR " +
      "(t.kind!='local' AND t.repo_id IN (SELECT id FROM repos WHERE host_id=?)) " +
      "ORDER BY t.id DESC",
  ).all(hostId, hostId) as Task[];
}

export function getOwnedTask(db: DB, id: number | string): Task | undefined {
  const hostId = localHostId(db);
  if (hostId == null) return undefined;
  return db.prepare(
    "SELECT t.* FROM tasks t WHERE t.id=? AND (" +
      "(t.kind='local' AND t.host_id=?) OR " +
      "(t.kind!='local' AND t.repo_id IN (SELECT id FROM repos WHERE host_id=?)))",
  ).get(id, hostId, hostId) as Task | undefined;
}

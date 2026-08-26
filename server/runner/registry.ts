import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { RunnerCapabilities } from "./protocol.js";

type DB = Database.Database;
const PAIRING_AGE_MS = 10 * 60 * 1000;

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runnerId(): string {
  return `run_${crypto.randomBytes(12).toString("base64url")}`;
}

function pairingCode(): string {
  const value = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

export interface PlatformRunner {
  id: string;
  user_id: number;
  name: string;
  os: string;
  arch: string;
  protocol_version: number;
  capabilities: RunnerCapabilities | Record<string, never>;
  status: "online" | "offline" | "upgrade_required";
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

type RunnerRow = Omit<PlatformRunner, "capabilities"> & { capabilities: string };

function shapeRunner(row: RunnerRow): PlatformRunner {
  let capabilities: PlatformRunner["capabilities"] = {};
  try { capabilities = JSON.parse(row.capabilities || "{}"); } catch {}
  return { ...row, capabilities };
}

export function createRunnerPairing(db: DB, userId: number, now = new Date()) {
  db.prepare("DELETE FROM platform_runner_pairings WHERE expires_at<=? OR claimed_at IS NOT NULL")
    .run(now.toISOString());
  const code = pairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_AGE_MS);
  db.prepare(
    "INSERT INTO platform_runner_pairings (code_hash,user_id,expires_at) VALUES (?,?,?)",
  ).run(hash(code), userId, expiresAt.toISOString());
  return { code, expires_at: expiresAt.toISOString() };
}

export function claimRunnerPairing(
  db: DB,
  code: string,
  input: { name: string; os: string; arch: string },
  now = new Date(),
): { runner: PlatformRunner; token: string } | null {
  const normalized = code.trim().toUpperCase();
  const pairing = db.prepare(
    "SELECT code_hash,user_id FROM platform_runner_pairings " +
      "WHERE code_hash=? AND claimed_at IS NULL AND expires_at>?",
  ).get(hash(normalized), now.toISOString()) as { code_hash: string; user_id: number } | undefined;
  if (!pairing) return null;

  const id = runnerId();
  const token = crypto.randomBytes(32).toString("base64url");
  const transaction = db.transaction(() => {
    const claimed = db.prepare(
      "UPDATE platform_runner_pairings SET claimed_at=? WHERE code_hash=? AND claimed_at IS NULL",
    ).run(now.toISOString(), pairing.code_hash).changes;
    if (!claimed) return false;
    db.prepare(
      "INSERT INTO platform_runners " +
        "(id,user_id,name,os,arch,token_hash,status) VALUES (?,?,?,?,?,?, 'offline')",
    ).run(id, pairing.user_id, input.name, input.os, input.arch, hash(token));
    return true;
  });
  if (!transaction()) return null;
  const runner = getRunner(db, id);
  return runner ? { runner, token } : null;
}

export function authenticateRunnerToken(db: DB, token: string): PlatformRunner | null {
  if (!token) return null;
  const row = db.prepare(
    "SELECT id,user_id,name,os,arch,protocol_version,capabilities,status,last_seen_at,created_at,updated_at " +
      "FROM platform_runners WHERE token_hash=?",
  ).get(hash(token)) as RunnerRow | undefined;
  return row ? shapeRunner(row) : null;
}

export function getRunner(db: DB, id: string): PlatformRunner | null {
  const row = db.prepare(
    "SELECT id,user_id,name,os,arch,protocol_version,capabilities,status,last_seen_at,created_at,updated_at " +
      "FROM platform_runners WHERE id=?",
  ).get(id) as RunnerRow | undefined;
  return row ? shapeRunner(row) : null;
}

export function listUserRunners(db: DB, userId: number): PlatformRunner[] {
  return (db.prepare(
    "SELECT id,user_id,name,os,arch,protocol_version,capabilities,status,last_seen_at,created_at,updated_at " +
      "FROM platform_runners WHERE user_id=? ORDER BY updated_at DESC,id",
  ).all(userId) as RunnerRow[]).map(shapeRunner);
}

export function updateRunnerHello(
  db: DB,
  id: string,
  protocolVersion: number,
  capabilities: RunnerCapabilities,
  online: boolean,
): PlatformRunner | null {
  db.prepare(
    "UPDATE platform_runners SET protocol_version=?,capabilities=?,status=?,last_seen_at=datetime('now')," +
      "updated_at=datetime('now') WHERE id=?",
  ).run(protocolVersion, JSON.stringify(capabilities), online ? "online" : "offline", id);
  return getRunner(db, id);
}

export function markRunnerOffline(db: DB, id: string): void {
  db.prepare(
    "UPDATE platform_runners SET status='offline',updated_at=datetime('now') WHERE id=?",
  ).run(id);
}

export function revokeRunner(db: DB, id: string, userId: number): boolean {
  return db.prepare("DELETE FROM platform_runners WHERE id=? AND user_id=?").run(id, userId).changes > 0;
}

export function createExecutionToken(
  db: DB,
  executionId: string,
  taskKey: string,
  now = new Date(),
): string {
  db.prepare("DELETE FROM platform_execution_tokens WHERE expires_at<=?").run(now.toISOString());
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO platform_execution_tokens (token_hash,execution_id,task_key,expires_at) VALUES (?,?,?,?)",
  ).run(hash(token), executionId, taskKey.toUpperCase(), expiresAt);
  return token;
}

export function authenticateExecutionToken(
  db: DB,
  token: string,
  now = new Date(),
): { execution_id: string; task_key: string } | null {
  if (!token) return null;
  return (db.prepare(
    "SELECT token.execution_id,token.task_key FROM platform_execution_tokens token " +
      "JOIN platform_runner_executions execution ON execution.id=token.execution_id " +
      "JOIN platform_tasks task ON task.task_key=token.task_key " +
      "WHERE token.token_hash=? AND token.expires_at>? " +
      "AND execution.status IN ('queued','starting','running','waiting') " +
      "AND task.runner_execution_id=execution.id",
  ).get(hash(token), now.toISOString()) as { execution_id: string; task_key: string } | undefined) || null;
}

export function revokeExecutionTokens(db: DB, executionId: string): void {
  db.prepare("DELETE FROM platform_execution_tokens WHERE execution_id=?").run(executionId);
}

// Schema setup for the dispatcher DB: create tables, reconcile columns onto
// DBs created by older schemas (SQLite has no ADD COLUMN IF NOT EXISTS), and run
// the one-time ./data -> ~/.task-dispatcher path rewrite. Pulled out of db.ts so
// it can run against ANY sqlite handle (incl. an in-memory test DB) without
// opening the real database file.
import type Database from "better-sqlite3";

type DB = Database.Database;

export interface SchemaOpts { didMigrate: boolean; legacyDir: string; dataDir: string; }

const CREATE_SQL = `
-- Platform identity is intentionally independent from GitHub/GitLab identity.
-- Google subject is the stable account key; email and name are mutable display
-- attributes refreshed at each login.
CREATE TABLE IF NOT EXISTS platform_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject)
);

-- The browser receives only the opaque token. SQLite stores its SHA-256 hash,
-- so copying the DB alone does not yield a reusable login cookie.
CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS platform_sessions_user_id
  ON platform_sessions(user_id);
CREATE INDEX IF NOT EXISTS platform_sessions_expires_at
  ON platform_sessions(expires_at);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  git_url TEXT NOT NULL,
  token TEXT,
  default_branch TEXT DEFAULT 'main',
  mirror_path TEXT,
  status TEXT DEFAULT 'cloning', -- cloning | ready | error
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT,             -- immutable HEAD captured before the agent starts
  work_branch TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT,
  worktree_path TEXT NOT NULL,
  session TEXT NOT NULL,
  status TEXT DEFAULT 'running', -- running | done | error | cleaned
  error TEXT,
  agent TEXT DEFAULT 'claude',   -- which coding-agent CLI runs the task: claude | codex | kimi
  agent_model TEXT,              -- non-Claude: the -m model; NULL == the node's default model
  created_at TEXT DEFAULT (datetime('now'))
);

-- Additional repository snapshots attached to one task. Each row owns a
-- detached worktree under worktrees/refs/<task-id>/<alias>; the referenced
-- repository's bare mirror remains the shared Git object store.
CREATE TABLE IF NOT EXISTS task_references (
  task_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  requested_ref TEXT NOT NULL,
  resolved_commit TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'reference',
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, alias)
);

-- registered machines reachable over ssh/mosh. Business operations are sent to
-- the target's Switchyard command surface; paths/tasks/repos stay in its own DB.
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target TEXT NOT NULL,           -- ssh target, e.g. user@host
  kind TEXT DEFAULT 'ssh',        -- ssh | mosh
  created_at TEXT DEFAULT (datetime('now'))
);

-- alternate model backends for claude. A task with provider_id set launches
-- claude with these as ANTHROPIC_* env vars (base_url/auth_token/model/…), so
-- the same Claude Code TUI drives e.g. GLM via its Anthropic-compatible
-- endpoint. provider_id NULL on a task == the machine's default claude login.
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,             -- display name, e.g. "GLM-4.6"
  base_url TEXT,                  -- ANTHROPIC_BASE_URL (the compatible endpoint)
  auth_token TEXT,                -- ANTHROPIC_AUTH_TOKEN (the provider's key)
  model TEXT,                     -- ANTHROPIC_MODEL
  small_fast_model TEXT,          -- ANTHROPIC_SMALL_FAST_MODEL (background/title model)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Evidence produced by onboarding checks. This stores facts such as the last
-- successful mobile Safari check-in, never credentials or a cached "completed"
-- flag; current readiness is always re-derived from live system state.
CREATE TABLE IF NOT EXISTS onboarding_events (
  kind TEXT PRIMARY KEY,
  detail TEXT,
  occurred_at TEXT DEFAULT (datetime('now'))
);

-- Alignyard's shared control-plane catalog. These rows only identify a Git
-- repository; clones, credentials and worktrees stay on each developer's
-- machine and are managed by the local ay client.
CREATE TABLE IF NOT EXISTS platform_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  git_url TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  protocol_initialized INTEGER NOT NULL DEFAULT 0,
  protocol_state TEXT NOT NULL DEFAULT 'uninitialized',
  protocol_error TEXT,
  created_by TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- A platform Task is the durable collaboration object for one requirement or
-- change. It is intentionally separate from the legacy runtime tasks table,
-- whose rows represent local CLI/tmux executions.
CREATE TABLE IF NOT EXISTS platform_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  owner TEXT NOT NULL,
  owner_user_id INTEGER,
  current_assignee TEXT,
  current_assignee_user_id INTEGER,
  task_type TEXT NOT NULL DEFAULT 'change',
  status TEXT NOT NULL DEFAULT 'draft',
  runtime_task_id INTEGER,
  workflow_error TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT NOT NULL DEFAULT 'none',
  merged_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks may span several peer repositories. Editable repositories may receive
-- changes; reference repositories are pinned read-only context.
CREATE TABLE IF NOT EXISTS platform_task_repositories (
  task_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT,
  work_branch TEXT,
  head_commit TEXT,
  assignee TEXT,
  manifest_status TEXT NOT NULL DEFAULT 'waiting',
  last_reported_at TEXT,
  remote_pushed_at TEXT,
  PRIMARY KEY (task_id, repository_id)
);

CREATE INDEX IF NOT EXISTS platform_task_repositories_repository_id
  ON platform_task_repositories(repository_id);

-- Review is a durable handoff, not just a Task status. Labels are immutable
-- display snapshots; nullable user ids preserve old rows while new handoffs use
-- stable authenticated identities.
CREATE TABLE IF NOT EXISTS platform_task_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  reviewer_user_id INTEGER,
  submitted_by TEXT NOT NULL,
  submitted_by_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  feedback TEXT,
  feedback_delivered_at TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  decided_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS platform_task_reviews_task_id
  ON platform_task_reviews(task_id, id DESC);

-- One platform Task may pass through several local runtimes as ownership moves
-- from author to reviewer and back. platform_tasks.runtime_task_id remains the
-- compatibility pointer to the current runtime; this table preserves history.
CREATE TABLE IF NOT EXISTS platform_task_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  runtime_task_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, runtime_task_id)
);

CREATE INDEX IF NOT EXISTS platform_task_executions_task_id
  ON platform_task_executions(task_id, id DESC);

-- Normalized manifest output reported by a local ay sync. The platform can
-- link and review these artifacts without ever reading the private checkout.
CREATE TABLE IF NOT EXISTS platform_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  document_id TEXT,
  kind TEXT NOT NULL,
  scope TEXT,
  path TEXT NOT NULL,
  title TEXT,
  owners TEXT NOT NULL DEFAULT '[]',
  relations TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  change_kind TEXT,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  base_commit TEXT,
  head_commit TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, repository_id, path)
);
`;

/** Add a column if it's missing — backfills schema drift on pre-existing DBs. */
function addColumn(db: DB, table: string, col: string, def: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

/**
 * Tear down schema for removed features. Idempotent: a DB that never had them
 * (or was already cleaned) is a no-op. DROP COLUMN needs SQLite ≥ 3.35, which
 * better-sqlite3 bundles.
 */
function dropDeprecated(db: DB) {
  db.exec("DROP TABLE IF EXISTS presets");
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const taskCols = columns("tasks");
  if (taskCols.includes("preset_id")) db.exec("ALTER TABLE tasks DROP COLUMN preset_id");
  if (taskCols.includes("skills")) db.exec("ALTER TABLE tasks DROP COLUMN skills");
  if (columns("repos").includes("project_path")) db.exec("ALTER TABLE repos DROP COLUMN project_path");
  if (columns("hosts").includes("session")) db.exec("ALTER TABLE hosts DROP COLUMN session");
}

/**
 * Reconcile the columns the code needs onto DBs created by older schemas. A
 * fresh DB already has them (from CREATE_SQL), so every call is a no-op there.
 *
 * mirror_path / worktree_path come FIRST: the path migration and the app's task
 * INSERTs reference them, and an old `tasks` table missing worktree_path is
 * exactly the "no such column: worktree_path" boot crash. Adding a NOT NULL
 * column to a table with rows requires a DEFAULT — '' is the "no worktree"
 * sentinel the app already treats as absent.
 */
function reconcileColumns(db: DB) {
  addColumn(db, "repos", "mirror_path", "TEXT");
  addColumn(db, "tasks", "worktree_path", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "tasks", "base_commit", "TEXT");              // exact dispatch baseline for read-only diffs
  // machine model (the hosts table doubles as "machines")
  addColumn(db, "hosts", "data_dir", "TEXT");                  // the machine's ~/.task-dispatcher
  addColumn(db, "hosts", "status", "TEXT DEFAULT 'unknown'");  // online | offline | unknown
  addColumn(db, "hosts", "last_checked", "TEXT");
  addColumn(db, "hosts", "tdsp_bin", "TEXT");                  // absolute path to the node's tdsp wrapper (bootstrapped); null = not yet
  // Stable peer identity + Tailscale-managed SSH transport. These fields are
  // metadata only: repos/tasks/worktrees remain in the target node's own DB.
  addColumn(db, "hosts", "node_id", "TEXT");                   // target Switchyard instance id (stable across network changes)
  addColumn(db, "hosts", "tailscale_id", "TEXT");              // current Tailscale node id
  addColumn(db, "hosts", "tailscale_dns", "TEXT");
  addColumn(db, "hosts", "tailscale_ip", "TEXT");
  addColumn(db, "hosts", "tailscale_user", "TEXT");
  addColumn(db, "hosts", "ssh_port", "INTEGER DEFAULT 22");
  addColumn(db, "hosts", "ssh_ready", "INTEGER");              // null=pending/unknown, 0=unavailable, 1=ready
  addColumn(db, "hosts", "managed_ssh", "INTEGER DEFAULT 0");  // use this instance's dedicated peer key
  addColumn(db, "hosts", "connection_source", "TEXT");         // manual | tailscale
  addColumn(db, "repos", "host_id", "INTEGER");                // which machine this repo lives on
  // repo-less local quick tasks (kind='local'): no mirror/worktree, repo_id=0,
  // branch/worktree columns are "" — they carry their own host_id and cwd.
  addColumn(db, "tasks", "kind", "TEXT DEFAULT 'repo'");       // 'repo' | 'local'
  addColumn(db, "tasks", "host_id", "INTEGER");                // local tasks: which machine
  addColumn(db, "tasks", "cwd", "TEXT");                       // local tasks: working dir
  addColumn(db, "tasks", "claude_session", "TEXT");           // Claude session id, captured by the SessionStart hook
  addColumn(db, "tasks", "provider_id", "INTEGER");           // alternate model backend; NULL == default claude login
  // the agent axis: which coding-agent CLI runs the task (claude default | codex
  // | kimi), plus an optional non-Claude -m model. Backfills to 'claude'.
  addColumn(db, "tasks", "agent", "TEXT DEFAULT 'claude'");
  addColumn(db, "tasks", "agent_model", "TEXT");
  // Retain the original boolean for backwards-compatible API consumers while
  // the state column distinguishes setup progress and actionable failures.
  addColumn(db, "platform_repositories", "protocol_initialized", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "platform_repositories", "protocol_state", "TEXT NOT NULL DEFAULT 'uninitialized'");
  addColumn(db, "platform_repositories", "protocol_error", "TEXT");
  addColumn(db, "platform_repositories", "created_by_user_id", "INTEGER");
  addColumn(db, "platform_tasks", "task_type", "TEXT NOT NULL DEFAULT 'change'");
  addColumn(db, "platform_tasks", "owner_user_id", "INTEGER");
  addColumn(db, "platform_tasks", "current_assignee", "TEXT");
  addColumn(db, "platform_tasks", "current_assignee_user_id", "INTEGER");
  addColumn(db, "platform_tasks", "runtime_task_id", "INTEGER");
  addColumn(db, "platform_tasks", "workflow_error", "TEXT");
  addColumn(db, "platform_tasks", "pr_number", "INTEGER");
  addColumn(db, "platform_tasks", "pr_url", "TEXT");
  addColumn(db, "platform_tasks", "pr_state", "TEXT NOT NULL DEFAULT 'none'");
  addColumn(db, "platform_tasks", "merged_at", "TEXT");
  addColumn(db, "platform_tasks", "completed_at", "TEXT");
  addColumn(db, "platform_task_repositories", "remote_pushed_at", "TEXT");
  addColumn(db, "platform_task_reviews", "reviewer_user_id", "INTEGER");
  addColumn(db, "platform_task_reviews", "submitted_by_user_id", "INTEGER");
  addColumn(db, "platform_task_reviews", "feedback", "TEXT");
  addColumn(db, "platform_task_reviews", "feedback_delivered_at", "TEXT");
  addColumn(db, "platform_artifacts", "document_id", "TEXT");
  addColumn(db, "platform_artifacts", "scope", "TEXT");
  addColumn(db, "platform_artifacts", "owners", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "platform_artifacts", "relations", "TEXT NOT NULL DEFAULT '[]'");
  addColumn(db, "platform_artifacts", "content", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "platform_artifacts", "content_hash", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS hosts_node_id_unique ON hosts(node_id) WHERE node_id IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS task_references_repo_id ON task_references(repo_id)");
  db.exec("UPDATE platform_tasks SET current_assignee=owner WHERE current_assignee IS NULL OR current_assignee=''");
  db.exec(`
    INSERT OR IGNORE INTO platform_task_executions
      (task_id,runtime_task_id,actor,role,agent,status)
    SELECT pt.id,pt.runtime_task_id,pt.owner,'author',rt.agent,'stopped'
    FROM platform_tasks pt
    JOIN tasks rt ON rt.id=pt.runtime_task_id
    WHERE pt.runtime_task_id IS NOT NULL
  `);
}

/** Migrate the prototype's title-based init convention and binary Repository
 * flag into explicit, queryable workflow state without discarding any rows. */
function normalizePlatformProtocolWorkflow(db: DB) {
  db.exec(`
    UPDATE platform_tasks
    SET task_type='repository_init'
    WHERE task_type='change' AND title LIKE 'Initialize Alignyard · %';

    UPDATE platform_repositories
    SET protocol_state = CASE
      WHEN protocol_initialized=1 THEN 'ready'
      WHEN protocol_state NOT IN ('uninitialized','initializing','ready','invalid') THEN 'uninitialized'
      ELSE protocol_state
    END;

    UPDATE platform_repositories
    SET protocol_state='initializing'
    WHERE protocol_state='uninitialized' AND EXISTS (
      SELECT 1
      FROM platform_task_repositories tr
      JOIN platform_tasks t ON t.id=tr.task_id
      WHERE tr.repository_id=platform_repositories.id
        AND t.task_type='repository_init'
        AND t.status IN ('draft','review')
    );

    UPDATE platform_repositories
    SET protocol_initialized=CASE WHEN protocol_state='ready' THEN 1 ELSE 0 END;
  `);
}

/**
 * Collapse the prototype's implementation-oriented Task states into the
 * product's four collaboration states. This is intentionally idempotent so
 * old databases are normalized on the first boot after upgrading while fresh
 * databases and subsequent boots remain no-ops.
 */
function normalizePlatformTaskStatuses(db: DB) {
  db.exec(`
    UPDATE platform_tasks
    SET status = CASE
      WHEN status IN ('draft', 'active', 'pushed') THEN 'draft'
      WHEN status IN ('review', 'in_review') THEN 'review'
      WHEN status IN ('approved', 'closed') THEN 'approved'
      WHEN status IN ('completed', 'merged') THEN 'completed'
      ELSE 'draft'
    END
    WHERE status NOT IN ('draft', 'review', 'approved', 'completed');

    UPDATE platform_tasks
    SET status='completed',completed_at=COALESCE(completed_at,merged_at,updated_at)
    WHERE status='approved' AND task_type='repository_init' AND pr_state='merged'
      AND EXISTS (
        SELECT 1 FROM platform_task_repositories ptr
        JOIN platform_repositories pr ON pr.id=ptr.repository_id
        WHERE ptr.task_id=platform_tasks.id AND ptr.mode='editable' AND pr.protocol_state='ready'
      );

    UPDATE platform_tasks
    SET completed_at=COALESCE(completed_at,merged_at,updated_at)
    WHERE status='completed' AND completed_at IS NULL
  `);
}

/**
 * One-time ./data -> ~/.task-dispatcher path rewrite: stored absolute mirror/
 * worktree paths still point under the old root, so swap the prefix. Idempotent —
 * once rewritten no row matches the legacy prefix, so re-running is a no-op.
 */
export function runPathMigration(db: DB, legacyDir: string, dataDir: string) {
  db.prepare("UPDATE repos SET mirror_path = replace(mirror_path, ?, ?) WHERE mirror_path LIKE ? || '%'")
    .run(legacyDir, dataDir, legacyDir);
  db.prepare("UPDATE tasks SET worktree_path = replace(worktree_path, ?, ?) WHERE worktree_path LIKE ? || '%'")
    .run(legacyDir, dataDir, legacyDir);
  db.prepare("UPDATE task_references SET worktree_path = replace(worktree_path, ?, ?) WHERE worktree_path LIKE ? || '%'")
    .run(legacyDir, dataDir, legacyDir);
}

/**
 * Create + reconcile the schema, then run the path migration ONLY when the data
 * dir was just physically moved (DID_MIGRATE) — not on every boot. The previous
 * guard (`LEGACY_DATA_DIR !== DATA_DIR`) was always true, so the migration ran
 * every startup and crashed any DB whose tasks table predated worktree_path.
 */
export function initSchema(db: DB, opts: SchemaOpts) {
  db.exec(CREATE_SQL);
  reconcileColumns(db);
  dropDeprecated(db);
  normalizePlatformTaskStatuses(db);
  normalizePlatformProtocolWorkflow(db);
  if (opts.didMigrate) runPathMigration(db, opts.legacyDir, opts.dataDir);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema, runPathMigration } from "./schema.ts";

const opts = (didMigrate: boolean) => ({ didMigrate, legacyDir: "/legacy", dataDir: "/data" });

// The reported boot crash: an old DB whose `tasks` table predates the
// worktree_path column. initSchema must backfill it instead of throwing
// "no such column: worktree_path".
test("initSchema backfills worktree_path and code baseline onto an old tasks table (regression)", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT, mirror_path TEXT)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo_id INTEGER, title TEXT)");
  db.prepare("INSERT INTO tasks (repo_id, title) VALUES (1, 'old')").run();

  assert.doesNotThrow(() => initSchema(db, opts(false)));
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("worktree_path"), "worktree_path should be backfilled");
  assert.ok(cols.includes("base_commit"), "base_commit should be backfilled");
  assert.equal(
    (db.prepare("SELECT worktree_path FROM tasks WHERE id=1").get() as { worktree_path: string }).worktree_path,
    "",
  );
  assert.equal(
    (db.prepare("SELECT base_commit FROM tasks WHERE id=1").get() as { base_commit: string | null }).base_commit,
    null,
  );
});

test("initSchema on a fresh DB has worktree_path and the newer columns", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["worktree_path", "base_commit", "kind", "host_id", "cwd"]) assert.ok(cols.includes(c), `missing ${c}`);
  assert.ok(!cols.includes("skills"), "removed skills metadata is not recreated");
  const referenceCols = (db.prepare("PRAGMA table_info(task_references)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(referenceCols, [
    "task_id", "repo_id", "alias", "requested_ref", "resolved_commit", "worktree_path", "mode", "created_at",
  ]);
});

test("initSchema stores compatible protocol state on platform repositories", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const columns = (db.prepare("PRAGMA table_info(platform_repositories)").all() as { name: string }[])
    .map((column) => column.name);
  assert.ok(columns.includes("protocol_initialized"));
  assert.ok(columns.includes("protocol_state"));
  assert.ok(columns.includes("protocol_error"));
  assert.ok(columns.includes("protocol_version"));
  assert.ok(columns.includes("framework_version"));
  db.prepare(
    "INSERT INTO platform_repositories (name,git_url,created_by) VALUES ('repo','git@example/repo','Phil')",
  ).run();
  assert.deepEqual(
    db.prepare("SELECT protocol_initialized,protocol_state,protocol_version,framework_version FROM platform_repositories").get(),
    { protocol_initialized: 0, protocol_state: "uninitialized", protocol_version: null, framework_version: 0 },
  );
});

test("initSchema stores platform runtime and pull-request workflow state", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const columns = (db.prepare("PRAGMA table_info(platform_tasks)").all() as { name: string }[])
    .map((column) => column.name);
  for (const field of ["owner_user_id", "current_assignee", "current_assignee_user_id", "runtime_task_id", "workflow_error", "pr_number", "pr_url", "pr_state", "merged_at", "completed_at"]) {
    assert.ok(columns.includes(field), `missing ${field}`);
  }
  const repositoryColumns = (db.prepare("PRAGMA table_info(platform_task_repositories)").all() as { name: string }[])
    .map((column) => column.name);
  assert.ok(repositoryColumns.includes("remote_pushed_at"));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_task_reviews'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_task_executions'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_users'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_sessions'").get());
  const reviewColumns = (db.prepare("PRAGMA table_info(platform_task_reviews)").all() as { name: string }[])
    .map((column) => column.name);
  assert.ok(reviewColumns.includes("reviewer_user_id"));
  assert.ok(reviewColumns.includes("submitted_by_user_id"));
  assert.ok(reviewColumns.includes("feedback"));
  assert.ok(reviewColumns.includes("feedback_delivered_at"));
  db.prepare("INSERT INTO platform_tasks (task_key,title,owner) VALUES ('AY-1','Init','Phil')").run();
  assert.equal((db.prepare("SELECT pr_state FROM platform_tasks").get() as { pr_state: string }).pr_state, "none");
});

test("initSchema migrates binary Repository state and title-based init Tasks", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const repositoryId = Number(db.prepare(
    "INSERT INTO platform_repositories (name,git_url,created_by,protocol_initialized) VALUES ('repo','git@example/repo','Phil',0)",
  ).run().lastInsertRowid);
  const taskId = Number(db.prepare(
    "INSERT INTO platform_tasks (task_key,title,owner) VALUES ('AY-001','Initialize Alignyard · repo','Phil')",
  ).run().lastInsertRowid);
  db.prepare(
    "INSERT INTO platform_task_repositories (task_id,repository_id,mode,base_branch) VALUES (?,?,'editable','main')",
  ).run(taskId, repositoryId);

  initSchema(db, opts(false));
  assert.deepEqual(
    db.prepare("SELECT protocol_state,protocol_initialized FROM platform_repositories WHERE id=?").get(repositoryId),
    { protocol_state: "initializing", protocol_initialized: 0 },
  );
  assert.equal(
    (db.prepare("SELECT task_type FROM platform_tasks WHERE id=?").get(taskId) as { task_type: string }).task_type,
    "repository_init",
  );
});

test("initSchema preserves an existing outdated Repository across restarts", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  db.prepare(
    "INSERT INTO platform_repositories " +
      "(name,git_url,created_by,protocol_initialized,protocol_state,protocol_error,protocol_version,framework_version) " +
      "VALUES ('repo','git@example/repo','Phil',1,'outdated','v1 可更新至 v2',2,1)",
  ).run();

  initSchema(db, opts(false));

  assert.deepEqual(
    db.prepare(
      "SELECT protocol_initialized,protocol_state,protocol_error,protocol_version,framework_version " +
        "FROM platform_repositories WHERE name='repo'",
    ).get(),
    {
      protocol_initialized: 1,
      protocol_state: "outdated",
      protocol_error: "v1 可更新至 v2",
      protocol_version: 2,
      framework_version: 1,
    },
  );
});

test("initSchema never completes a current Repository Task as a startup side effect", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const repositoryId = Number(db.prepare(
    "INSERT INTO platform_repositories " +
      "(name,git_url,created_by,protocol_initialized,protocol_state) " +
      "VALUES ('repo','git@example/repo','Phil',1,'ready')",
  ).run().lastInsertRowid);
  const taskId = Number(db.prepare(
    "INSERT INTO platform_tasks " +
      "(task_key,title,owner,current_assignee,task_type,status,pr_state,merged_at) " +
      "VALUES ('AY-001','Initialize','Phil','Phil','repository_init','approved','merged',datetime('now'))",
  ).run().lastInsertRowid);
  db.prepare(
    "INSERT INTO platform_task_repositories (task_id,repository_id,mode,base_branch) " +
      "VALUES (?,?,'editable','main')",
  ).run(taskId, repositoryId);

  initSchema(db, opts(false));

  assert.deepEqual(
    db.prepare("SELECT status,completed_at FROM platform_tasks WHERE id=?").get(taskId),
    { status: "approved", completed_at: null },
  );
});

test("initSchema does not create a Platform knowledge store", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('platform_artifacts','platform_execution_tokens')",
  ).all() as { name: string }[]).map((row) => row.name);
  assert.deepEqual(names, []);
});

test("initSchema keeps only the Runner-local ownership anchor on fresh databases", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const cols = (db.prepare("PRAGMA table_info(hosts)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["node_id", "data_dir", "status"]) assert.ok(cols.includes(c), `missing hosts.${c}`);
  for (const c of ["tdsp_bin", "tailscale_id", "ssh_ready", "managed_ssh"]) {
    assert.ok(!cols.includes(c), `fresh schema must not create hosts.${c}`);
  }
});

// The agent axis: every task records which coding-agent CLI it runs (claude by
// default, or another local agent) plus an optional non-Claude model. A row
// inserted without naming an agent must default to 'claude'.
test("initSchema on a fresh DB has the agent columns, defaulting agent to claude", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("agent"), "agent column present");
  assert.ok(cols.includes("agent_model"), "agent_model column present");
  db.prepare("INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session) VALUES (1,'m','f','t','/wt','s')").run();
  const row = db.prepare("SELECT agent, agent_model FROM tasks WHERE id=1").get() as { agent: string; agent_model: string | null };
  assert.equal(row.agent, "claude", "agent defaults to claude");
  assert.equal(row.agent_model, null, "no agent model by default");
});

// An old tasks table predating the agent column must be backfilled (not throw),
// and its existing rows must read as 'claude'.
test("initSchema backfills agent='claude' onto an old tasks table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, name TEXT, mirror_path TEXT)");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo_id INTEGER, title TEXT)");
  db.prepare("INSERT INTO tasks (repo_id, title) VALUES (1, 'old')").run();

  assert.doesNotThrow(() => initSchema(db, opts(false)));
  const row = db.prepare("SELECT agent FROM tasks WHERE id=1").get() as { agent: string };
  assert.equal(row.agent, "claude", "existing rows backfill to claude");
});

// Removed features leave no schema behind. Historical data may contain presets,
// task skill metadata, a GitLab project path, and a single host session; none is
// used by current code.
test("initSchema tears down removed feature schema", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo_id INTEGER, preset_id INTEGER, skills TEXT)");
  db.exec("CREATE TABLE repos (id INTEGER PRIMARY KEY, project_path TEXT)");
  db.exec("CREATE TABLE hosts (id INTEGER PRIMARY KEY, session TEXT)");
  db.exec("CREATE TABLE presets (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("CREATE TABLE platform_artifacts (id INTEGER PRIMARY KEY, content TEXT)");
  db.exec("CREATE TABLE platform_execution_tokens (token_hash TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO presets (name) VALUES ('legacy')").run();

  initSchema(db, opts(false));

  const presets = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'").get();
  assert.equal(presets, undefined, "presets table should be dropped");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_artifacts'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='platform_execution_tokens'").get(), undefined);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes("preset_id"), "tasks.preset_id should be dropped");
  assert.ok(!cols.includes("skills"), "tasks.skills should be dropped");
  const repoCols = (db.prepare("PRAGMA table_info(repos)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(!repoCols.includes("project_path"), "repos.project_path should be dropped");
  const hostCols = (db.prepare("PRAGMA table_info(hosts)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(!hostCols.includes("session"), "hosts.session should be dropped");
});

test("initSchema on a fresh DB never creates a presets table", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const presets = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'").get();
  assert.equal(presets, undefined);
});

test("initSchema collapses prototype platform Task statuses to the four collaboration states", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const insert = db.prepare(
    "INSERT INTO platform_tasks (task_key,title,owner,status) VALUES (?,?,?,?)",
  );
  for (const [index, status] of [
    "draft", "active", "pushed", "in_review", "review", "approved", "completed", "merged", "closed", "unexpected",
  ].entries()) {
    insert.run(`AY-${index}`, `Task ${index}`, "Phil", status);
  }

  initSchema(db, opts(false));
  const statuses = (db.prepare("SELECT status FROM platform_tasks ORDER BY id").all() as { status: string }[])
    .map((row) => row.status);
  assert.deepEqual(statuses, [
    "draft", "draft", "draft", "review", "review", "approved", "completed", "completed", "approved", "draft",
  ]);
});

test("initSchema does not recreate removed onboarding storage", () => {
  const db = new Database(":memory:");
  initSchema(db, opts(false));
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_events'").get();
  assert.equal(table, undefined);
});

test("path migration runs only when didMigrate is true", () => {
  const seed = (db: Database.Database) => {
    db.prepare(
      "INSERT INTO tasks (repo_id, base_branch, work_branch, title, worktree_path, session) VALUES (1,'m','f','t',?, 's')",
    ).run("/legacy/wt/x");
    db.prepare(
      "INSERT INTO task_references (task_id,repo_id,alias,requested_ref,resolved_commit,worktree_path) VALUES (1,2,'api','main',?,?)",
    ).run("a".repeat(40), "/legacy/worktrees/refs/1/api");
  };
  const wt = (db: Database.Database) =>
    (db.prepare("SELECT worktree_path FROM tasks WHERE id=1").get() as { worktree_path: string }).worktree_path;
  const refWt = (db: Database.Database) =>
    (db.prepare("SELECT worktree_path FROM task_references WHERE task_id=1").get() as { worktree_path: string }).worktree_path;

  // didMigrate=false → stored legacy path left untouched
  const skip = new Database(":memory:");
  initSchema(skip, opts(false));
  seed(skip);
  initSchema(skip, opts(false));
  assert.equal(wt(skip), "/legacy/wt/x");
  assert.equal(refWt(skip), "/legacy/worktrees/refs/1/api");

  // explicit migration → prefix rewritten to the new data dir
  const mig = new Database(":memory:");
  initSchema(mig, opts(false));
  seed(mig);
  runPathMigration(mig, "/legacy", "/data");
  assert.equal(wt(mig), "/data/wt/x");
  assert.equal(refWt(mig), "/data/worktrees/refs/1/api");
});

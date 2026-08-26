import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { upsertPlatformUser } from "../auth/auth.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  createPlatformTask,
  decidePlatformTaskReview,
  deletePlatformTask,
  deletePlatformRepository,
  getPlatformRepository,
  getPlatformTask,
  linkPlatformTaskRuntime,
  listPlatformMembers,
  listPlatformRepositories,
  markPlatformPullRequestMerged,
  platformRepositoryTaskCount,
  PlatformValidationError,
  recordPlatformPullRequest,
  recordPlatformTaskPush,
  setPlatformRepositoryProtocolState,
  setPlatformTaskWorkflowError,
  submitPlatformTaskReview,
  updatePlatformTaskCommits,
  updatePlatformTaskStatus,
} from "./catalog.ts";

function memoryDb() {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  return db;
}

test("platform repository catalog stores locators without credentials or checkout paths", () => {
  const db = memoryDb();
  const repo = createPlatformRepository(db, {
    name: "alignyard",
    git_url: "git@example.com:team/alignyard.git",
    default_branch: "main",
    created_by: "张三",
  });

  assert.equal(repo.name, "alignyard");
  assert.equal(repo.protocol_initialized, false);
  assert.equal(repo.protocol_state, "uninitialized");
  assert.deepEqual(listPlatformRepositories(db), [repo]);
  const columns = (db.prepare("PRAGMA table_info(platform_repositories)").all() as { name: string }[])
    .map((column) => column.name);
  assert.ok(!columns.includes("token"));
  assert.ok(!columns.includes("mirror_path"));
});

test("platform Task supports several editable and reference repositories", () => {
  const db = memoryDb();
  const app = createPlatformRepository(db, {
    name: "app",
    git_url: "git@example.com:team/app.git",
    default_branch: "develop",
    created_by: "张三",
  });
  const api = createPlatformRepository(db, {
    name: "api",
    git_url: "git@example.com:team/api.git",
    created_by: "张三",
  });
  setPlatformRepositoryProtocolState(db, app.id, "ready");

  const task = createPlatformTask(db, {
    title: "统一登录态",
    description: "同时更新 app，读取 api 契约作为上下文。",
    owner: "张三",
    repositories: [
      { repository_id: app.id, mode: "editable" },
      { repository_id: api.id, mode: "reference", base_branch: "release" },
    ],
  });

  assert.equal(task.key, "AY-001");
  assert.equal(task.status, "draft");
  assert.equal(task.repositories.length, 2);
  assert.equal(task.repositories[0].mode, "editable");
  assert.equal(task.repositories[0].base_branch, "develop");
  assert.equal(task.repositories[0].work_branch, "change/ay-001/member");
  assert.equal(task.repositories[1].mode, "reference");
  assert.equal(task.repositories[1].base_branch, "release");
  assert.equal(task.repositories[1].work_branch, null);
  assert.equal(getPlatformTask(db, "ay-001")?.title, "统一登录态");
});

test("platform Task requires at least one editable repository and validates status", () => {
  const db = memoryDb();
  const repo = createPlatformRepository(db, {
    name: "docs",
    git_url: "git@example.com:team/docs.git",
    created_by: "李四",
  });
  setPlatformRepositoryProtocolState(db, repo.id, "ready");

  assert.throws(() => createPlatformTask(db, {
    title: "只读任务",
    owner: "李四",
    repositories: [{ repository_id: repo.id, mode: "reference" }],
  }), PlatformValidationError);

  const task = createPlatformTask(db, {
    title: "补充文档",
    owner: "李四",
    repositories: [{ repository_id: repo.id, mode: "editable" }],
  });
  assert.equal(updatePlatformTaskStatus(db, task.key, "review")?.status, "review");
  assert.equal(updatePlatformTaskStatus(db, task.key, "draft")?.status, "draft");
  assert.equal(updatePlatformTaskStatus(db, task.key, "review")?.status, "review");
  assert.equal(updatePlatformTaskStatus(db, task.key, "approved")?.status, "approved");
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "draft"), PlatformValidationError);
  const completed = updatePlatformTaskStatus(db, task.key, "completed");
  assert.equal(completed?.status, "completed");
  assert.ok(completed?.completed_at);
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "approved"), PlatformValidationError);
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "in_review"), PlatformValidationError);
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "unknown"), PlatformValidationError);
});

test("Repository initialization is a first-class idempotent Task and gates ordinary editable work", () => {
  const db = memoryDb();
  const repo = createPlatformRepository(db, {
    name: "new-service",
    git_url: "git@example.com:team/new-service.git",
    created_by: "Phil",
  });

  assert.throws(() => createPlatformTask(db, {
    title: "Feature before bootstrap",
    owner: "Phil",
    repositories: [{ repository_id: repo.id, mode: "editable" }],
  }), /尚未完成 Alignyard 初始化/);

  const first = createRepositoryInitializationTask(db, repo.id, "Phil");
  const second = createRepositoryInitializationTask(db, repo.id, "Phil");
  assert.equal(first.key, second.key);
  assert.equal(first.task_type, "repository_init");
  assert.match(first.description || "", /架构、稳定接口与维护流程/);
  assert.equal(first.repositories.length, 1);
  assert.equal(first.repositories[0].mode, "editable");
  assert.equal(listPlatformRepositories(db)[0].protocol_state, "initializing");
});

test("requesting changes on Repository Init requires a fresh sync before another Review", () => {
  const db = memoryDb();
  const repository = createPlatformRepository(db, {
    name: "new-service", git_url: "git@example/new-service", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  db.prepare(
    "UPDATE platform_task_repositories SET manifest_status='valid' WHERE task_id=? AND repository_id=?",
  ).run(task.id, repository.id);
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,document_id,kind,scope,path,title) " +
      "VALUES (?,?,?,'doc','shared','.alignyard/docs/shared/overview.md','Repository Overview')",
  ).run(task.id, repository.id, "overview");

  assert.equal(updatePlatformTaskStatus(db, task.key, "review")?.status, "review");
  const draft = updatePlatformTaskStatus(db, task.key, "draft");
  assert.equal(draft?.repositories[0].manifest_status, "waiting");
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "review"), /ay validate、ay sync/);
});

test("an approved Repository Init with an open change request can return to draft", () => {
  const db = memoryDb();
  const repository = createPlatformRepository(db, {
    name: "new-service", git_url: "git@example/new-service", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  db.prepare(
    "UPDATE platform_task_repositories SET manifest_status='valid' WHERE task_id=? AND repository_id=?",
  ).run(task.id, repository.id);
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,document_id,kind,scope,path,title) " +
      "VALUES (?,?,?,'doc','shared','.alignyard/docs/shared/overview.md','仓库概览')",
  ).run(task.id, repository.id, "overview");

  updatePlatformTaskStatus(db, task.key, "review");
  recordPlatformPullRequest(db, task.key, {
    number: 42, url: "https://github.com/example/new-service/pull/42", state: "open",
  });
  updatePlatformTaskStatus(db, task.key, "approved");
  const draft = updatePlatformTaskStatus(db, task.key, "draft");

  assert.equal(draft?.status, "draft");
  assert.equal(draft?.pr_state, "open");
  assert.equal(draft?.pr_number, 42);
  assert.equal(draft?.repositories[0].manifest_status, "waiting");
});

test("Repository Init completes only after its change request is merged and Repository is ready", () => {
  const db = memoryDb();
  const repository = createPlatformRepository(db, {
    name: "new-service", git_url: "git@example/new-service", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  db.prepare("UPDATE platform_tasks SET status='approved' WHERE id=?").run(task.id);

  assert.throws(() => updatePlatformTaskStatus(db, task.key, "completed"), /合并请求已合入/);
  markPlatformPullRequestMerged(db, task.key);
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "completed"), /Repository 就绪/);
  setPlatformRepositoryProtocolState(db, repository.id, "ready");

  const completed = updatePlatformTaskStatus(db, task.key, "completed");
  assert.equal(completed?.status, "completed");
  assert.ok(completed?.completed_at);
});

test("platform Task records its runtime, commits, workflow error, and pull request", () => {
  const db = memoryDb();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (7,1,'new-service','git@example/new-service','/mirror','ready')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,base_commit,work_branch,title,worktree_path,session,status,agent) " +
      "VALUES (9,7,'main',?,'change/ay-001/phil','runtime','/wt','tdsp-9','running','codex')",
  ).run("a".repeat(40));
  const repository = createPlatformRepository(db, {
    name: "new-service", git_url: "git@example/new-service", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");

  const linked = linkPlatformTaskRuntime(db, task.key, {
    id: 9, work_branch: "change/ay-001/phil", base_commit: "a".repeat(40),
  });
  assert.equal(linked?.runtime_task_id, 9);
  assert.equal(linked?.runtime_status, "running");
  assert.equal(linked?.runtime_agent, "codex");
  assert.equal(linked?.current_assignee, "Phil");
  assert.equal(linked?.executions[0].role, "author");
  assert.equal(linked?.repositories[0].base_commit, "a".repeat(40));

  assert.equal(setPlatformTaskWorkflowError(db, task.key, "boom")?.workflow_error, "boom");
  assert.equal(updatePlatformTaskCommits(db, task.key, { head_commit: "b".repeat(40) })?.repositories[0].head_commit, "b".repeat(40));
  const withPr = recordPlatformPullRequest(db, task.key, {
    number: 42, url: "https://github.com/example/repo/pull/42", state: "open",
  });
  assert.equal(withPr?.pr_number, 42);
  assert.equal(withPr?.pr_state, "open");
  assert.equal(markPlatformPullRequestMerged(db, task.key)?.pr_state, "merged");
});

test("Review records handoff, remote push, reviewer execution, and decision separately", () => {
  const db = memoryDb();
  const phil = upsertPlatformUser(db, "google", { sub: "phil", name: "Phil", email: "phil@example.com" });
  const alice = upsertPlatformUser(db, "google", { sub: "alice", name: "Alice", email: "alice@example.com" });
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (7,1,'service','git@example/service','/mirror','ready')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,repo_id,base_branch,base_commit,work_branch,title,worktree_path,session,status,agent) " +
      "VALUES (9,7,'main',?,'change/ay-001/phil','author','/author','tdsp-9','cleaned','codex')," +
      "(10,7,'main',?,'change/ay-001/phil','review','/review','tdsp-10','running','claude')",
  ).run("a".repeat(40), "a".repeat(40));
  const repository = createPlatformRepository(db, {
    name: "service", git_url: "git@example/service", created_by: "Phil", created_by_user_id: phil.id,
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil", phil.id);
  linkPlatformTaskRuntime(db, task.key, {
    id: 9, work_branch: "change/ay-001/phil", base_commit: "a".repeat(40), actor: "Phil", role: "author", agent: "codex",
  });
  recordPlatformTaskPush(db, task.key, "b".repeat(40));
  const handedOff = submitPlatformTaskReview(db, task.key, {
    reviewer: "Alice",
    reviewer_user_id: alice.id,
    submitted_by: "Phil",
    submitted_by_user_id: phil.id,
  });

  assert.equal(handedOff?.status, "review");
  assert.equal(handedOff?.current_assignee, "Alice");
  assert.equal(handedOff?.current_assignee_user_id, alice.id);
  assert.equal(handedOff?.review?.status, "pending");
  assert.equal(handedOff?.repositories[0].remote_pushed_at != null, true);
  const reviewerRuntime = linkPlatformTaskRuntime(db, task.key, {
    id: 10, work_branch: "change/ay-001/phil", base_commit: "a".repeat(40), actor: "Alice", role: "reviewer", agent: "claude",
  });
  assert.equal(reviewerRuntime?.executions.length, 2);
  assert.equal(reviewerRuntime?.executions[1].actor, "Alice");
  assert.deepEqual(listPlatformMembers(db).map((member) => member.name), ["Alice", "Phil"]);

  const approved = decidePlatformTaskReview(db, task.key, "approved");
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.review?.status, "approved");
  assert.equal(approved?.current_assignee, "Phil");
  assert.equal(approved?.current_assignee_user_id, phil.id);
});

test("Repository deletion is blocked by Task references and otherwise removes metadata", () => {
  const db = memoryDb();
  const unused = createPlatformRepository(db, {
    name: "unused", git_url: "git@example.com:team/unused.git", created_by: "Phil",
  });
  assert.equal(deletePlatformRepository(db, unused.id)?.id, unused.id);
  assert.equal(listPlatformRepositories(db).length, 0);

  const used = createPlatformRepository(db, {
    name: "used", git_url: "git@example.com:team/used.git", created_by: "Phil",
  });
  createRepositoryInitializationTask(db, used.id, "Phil");
  assert.equal(platformRepositoryTaskCount(db, used.id), 1);
  assert.throws(() => deletePlatformRepository(db, used.id), /已被 1 个 Task 引用/);
});

test("deleting an unfinished Repository Init removes its snapshot and releases the Repository", () => {
  const db = memoryDb();
  const repository = createPlatformRepository(db, {
    name: "new-service", git_url: "git@example.com:team/new-service.git", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,kind,path,title) VALUES (?,?, 'doc',?,?)",
  ).run(task.id, repository.id, ".alignyard/docs/shared/overview.md", "仓库概览");

  const deleted = deletePlatformTask(db, task.key);

  assert.equal(deleted?.key, task.key);
  assert.equal(getPlatformTask(db, task.key), undefined);
  assert.equal(platformRepositoryTaskCount(db, repository.id), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_artifacts").get() as { count: number }).count, 0);
  assert.equal(getPlatformRepository(db, repository.id)?.protocol_state, "uninitialized");
});

test("deleting a completed Repository Init preserves the ready Repository", () => {
  const db = memoryDb();
  const repository = createPlatformRepository(db, {
    name: "ready-service", git_url: "git@example.com:team/ready-service.git", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  recordPlatformPullRequest(db, task.key, {
    number: 7, url: "https://github.com/example/ready-service/pull/7", state: "merged",
  });
  setPlatformRepositoryProtocolState(db, repository.id, "ready");

  deletePlatformTask(db, task.key);

  assert.equal(getPlatformRepository(db, repository.id)?.protocol_state, "ready");
});

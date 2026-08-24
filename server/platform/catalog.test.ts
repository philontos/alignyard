import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  createPlatformTask,
  deletePlatformRepository,
  getPlatformTask,
  linkPlatformTaskRuntime,
  listPlatformRepositories,
  markPlatformPullRequestMerged,
  platformRepositoryTaskCount,
  PlatformValidationError,
  recordPlatformPullRequest,
  setPlatformRepositoryProtocolState,
  setPlatformTaskWorkflowError,
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

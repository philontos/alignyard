import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  createPlatformRepository,
  createPlatformTask,
  getPlatformTask,
  listPlatformRepositories,
  PlatformValidationError,
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
  assert.equal(updatePlatformTaskStatus(db, task.key, "in_review")?.status, "in_review");
  assert.throws(() => updatePlatformTaskStatus(db, task.key, "unknown"), PlatformValidationError);
});

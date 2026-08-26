import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "./schema.ts";
import {
  getOwnedRepo,
  getOwnedTask,
  listOwnedRepos,
  listOwnedTasks,
} from "./ownership.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function mixedOwnershipDb() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,data_dir,status) VALUES (1,'A','','local','/a/data','online')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,data_dir,status) VALUES (2,'B','dev@b','ssh','/b/data','online')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (11,1,'a-repo','a','/a/mirrors/11.git','ready')").run();
  db.prepare("INSERT INTO repos (id,host_id,name,git_url,mirror_path,status) VALUES (22,2,'b-repo','b','/b/mirrors/22.git','ready')").run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES (101,'repo',11,'main','feat/a','A repo task','/a/wt','tdsp-a','running')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,repo_id,base_branch,work_branch,title,worktree_path,session,status) VALUES (202,'repo',22,'main','feat/b','B repo task','/b/wt','tdsp-b','running')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status,cwd) VALUES (103,'local',1,0,'','','A shell','','tdsp-a-shell','running','/a')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id,kind,host_id,repo_id,base_branch,work_branch,title,worktree_path,session,status,cwd) VALUES (204,'local',2,0,'','','B shell','','tdsp-b-shell','running','/b')",
  ).run();
  return db;
}

test("owner-local reads never mix another machine's repos or tasks", () => {
  const db = mixedOwnershipDb();
  assert.deepEqual(listOwnedRepos(db).map((repo) => repo.id), [11]);
  assert.deepEqual(listOwnedTasks(db).map((task) => task.id), [103, 101]);
  assert.equal(getOwnedRepo(db, 22), undefined);
  assert.equal(getOwnedTask(db, 202), undefined);
  assert.equal(getOwnedTask(db, 204), undefined);
});

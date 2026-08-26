import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { authenticateExecutionToken } from "../runner/registry.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  getPlatformTask,
} from "./catalog.ts";
import {
  createChangeRequestOnRunner,
  decideReviewOnRunner,
  mergeChangeRequestOnRunner,
  startReviewOnRunner,
  startTaskOnRunner,
  submitTaskForReviewOnRunner,
} from "./runner-workflow.ts";

function fixture() {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  db.prepare("INSERT INTO platform_users (provider,provider_subject,name) VALUES ('google','author','Author')").run();
  db.prepare("INSERT INTO platform_users (provider,provider_subject,name) VALUES ('google','reviewer','Reviewer')").run();
  const capabilities = JSON.stringify({
    git: true, tmux: true, ssh: true,
    agents: { codex: true, claude: true, kimi: true },
    forge: { gh: true, glab: true },
  });
  db.prepare(
    "INSERT INTO platform_runners (id,user_id,name,os,arch,token_hash,capabilities,status) VALUES (?,?,?,?,?,?,?,'online')",
  ).run("author-runner", 1, "Author Mac", "darwin", "arm64", "author-token", capabilities);
  db.prepare(
    "INSERT INTO platform_runners (id,user_id,name,os,arch,token_hash,capabilities,status) VALUES (?,?,?,?,?,?,?,'online')",
  ).run("reviewer-runner", 2, "Reviewer Mac", "darwin", "arm64", "reviewer-token", capabilities);
  const repository = createPlatformRepository(db, {
    name: "example", git_url: "git@github.com:team/example.git", default_branch: "main",
    created_by: "Author", created_by_user_id: 1,
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Author", 1);
  const calls: Array<{ runnerId: string; method: string; params: any }> = [];
  let nextTaskId = 10;
  const gateway = {
    isOnline: () => true,
    async call(runnerId: string, method: string, params: any) {
      calls.push({ runnerId, method, params });
      if (method === "execution.start") return {
        runner_task_id: nextTaskId++, session: `session-${nextTaskId}`,
        status: "running", work_branch: params.work_branch, base_commit: "base-sha",
      };
      if (method === "execution.prepare-review") return {
        runner_task_id: params.runner_task_id, session: "author-session", status: "stopped",
        work_branch: "change/ay-001/author", base_commit: "base-sha", head_commit: "head-sha",
      };
      if (method === "execution.status") return {
        runner_task_id: params.runner_task_id,
        session: "review-session",
        status: "running",
        work_branch: "review/ay-001/1",
        base_commit: "base-sha",
        head_commit: "head-sha",
      };
      if (method === "change-request.create") return { number: 7, url: "https://github.com/team/example/pull/7", state: "open" };
      if (method === "change-request.merge") return { number: 7, url: "https://github.com/team/example/pull/7", state: "merged" };
      if (method === "repository.refresh-protocol") return { state: "ready", error: null };
      return { ok: true };
    },
  };
  return { db, repository, task, calls, env: { db, gateway: gateway as any } };
}

test("Runner workflow completes author, review, pull request and merge without cloud checkout", async () => {
  const { db, repository, task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };

  const started = await startTaskOnRunner(env, task.key, "https://alignyard.example.com", author, "codex");
  assert.equal(started.runtime_created, true);
  assert.equal(started.task.runner_id, "author-runner");
  assert.ok(calls.find((call) => call.method === "execution.start")?.params.env.AY_PLATFORM_TOKEN);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }).count, 0);

  db.prepare(
    "UPDATE platform_task_repositories SET manifest_status='valid',base_commit='base-sha',head_commit='head-sha' " +
      "WHERE task_id=? AND repository_id=?",
  ).run(task.id, repository.id);
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,document_id,kind,scope,path,title,base_commit,head_commit) " +
      "VALUES (?,?,?,'doc','shared','.alignyard/docs/shared/overview.md','仓库概览','base-sha','head-sha')",
  ).run(task.id, repository.id, "overview");

  const submitted = await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  assert.equal(submitted.status, "review");
  assert.ok(submitted.repositories[0].remote_pushed_at);

  const reviewStarted = await startReviewOnRunner(
    env, task.key, "https://alignyard.example.com", reviewer, "claude",
  );
  assert.equal(reviewStarted.task.review?.status, "in_progress");
  assert.equal(reviewStarted.task.runner_id, "reviewer-runner");
  const reviewerExecution = db.prepare(
    "SELECT work_branch FROM platform_runner_executions WHERE id=?",
  ).get(reviewStarted.task.runner_execution_id) as { work_branch: string };
  assert.equal(reviewerExecution.work_branch, "review/ay-001/1");
  assert.equal(reviewStarted.task.repositories[0].work_branch, "change/ay-001/author");
  const approved = await decideReviewOnRunner(env, task.key, reviewer, "approved");
  assert.equal(approved.status, "approved");
  assert.equal(approved.runner_id, "author-runner");

  const withRequest = await createChangeRequestOnRunner(env, task.key, author);
  assert.equal(withRequest.pr_state, "open");
  const merged = await mergeChangeRequestOnRunner(env, task.key, author);
  assert.equal(merged.task.status, "completed");
  assert.equal(merged.task.pr_state, "merged");
  assert.equal(merged.repository.protocol_state, "ready");
  assert.equal(getPlatformTask(db, task.key)?.status, "completed");
});

test("a lost start response retries the same execution id and deterministic work branch", async () => {
  const { db, task, calls, env } = fixture();
  let attempts = 0;
  env.gateway.call = async (runnerId: string, method: string, params: any) => {
    calls.push({ runnerId, method, params });
    if (method !== "execution.start") return { ok: true };
    attempts += 1;
    if (attempts === 1) throw new Error("response lost");
    return {
      runner_task_id: 77,
      session: "session-77",
      status: "running",
      work_branch: params.work_branch,
      base_commit: "base-sha",
    };
  };

  const actor = { id: 1, name: "Author" };
  await assert.rejects(
    startTaskOnRunner(env, task.key, "https://alignyard.example.com", actor, "codex"),
    /response lost/,
  );
  const failedCall = calls.find((call) => call.method === "execution.start")!;
  assert.match(failedCall.params.work_branch, /^change\/ay-001\//);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_runner_executions").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_execution_tokens").get() as { count: number }).count, 0);

  const retried = await startTaskOnRunner(env, task.key, "https://alignyard.example.com", actor, "codex");
  assert.equal(retried.task.runtime_task_id, 77);
  const startCalls = calls.filter((call) => call.method === "execution.start");
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0].params.execution_id, startCalls[1].params.execution_id);
  assert.equal(startCalls[0].params.work_branch, startCalls[1].params.work_branch);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_execution_tokens").get() as { count: number }).count, 1);
});

test("changes requested resumes the sticky Author execution with a fresh sync token", async () => {
  const { db, repository, task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };
  await startTaskOnRunner(env, task.key, "https://alignyard.example.com", author, "codex");
  const firstStart = calls.find((call) => call.method === "execution.start")!;
  const firstToken = firstStart.params.env.AY_PLATFORM_TOKEN as string;

  db.prepare(
    "UPDATE platform_task_repositories SET manifest_status='valid',base_commit='base-sha',head_commit='head-sha' " +
      "WHERE task_id=? AND repository_id=?",
  ).run(task.id, repository.id);
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,document_id,kind,scope,path,title,base_commit,head_commit) " +
      "VALUES (?,?,?,'doc','shared','.alignyard/docs/shared/overview.md','仓库概览','base-sha','head-sha')",
  ).run(task.id, repository.id, "overview");
  await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  assert.equal(authenticateExecutionToken(db, firstToken), null);

  await decideReviewOnRunner(env, task.key, reviewer, "changes_requested", "请补测试");
  const resumed = await startTaskOnRunner(env, task.key, "https://alignyard.example.com", author, "codex");
  assert.equal(resumed.runtime_created, false);
  const resumeCall = calls.find((call) => call.method === "execution.resume")!;
  const resumedToken = resumeCall.params.env.AY_PLATFORM_TOKEN as string;
  assert.notEqual(resumedToken, firstToken);
  assert.equal(authenticateExecutionToken(db, firstToken), null);
  assert.equal(authenticateExecutionToken(db, resumedToken)?.task_key, task.key);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_execution_tokens").get() as { count: number }).count, 1);
});

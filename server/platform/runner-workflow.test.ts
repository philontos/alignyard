import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  createRepositoryUpdateTask,
  createPlatformTask,
  getPlatformTask,
  setPlatformRepositoryProtocolState,
} from "./catalog.ts";
import {
  createChangeRequestOnRunner,
  decideReviewOnRunner,
  mergeChangeRequestOnRunner,
  startReviewOnRunner,
  startTaskOnRunner,
  submitTaskForReviewOnRunner,
  taskKnowledgeOnRunner,
  taskWorktreeOnRunner,
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
      if (method === "execution.knowledge") return params.document_id
        ? { document: { id: params.document_id, title: "仓库概览", content: "# 仓库概览" } }
        : { documents: [{ id: "doc.shared.overview", title: "仓库概览", path: ".alignyard/docs/shared/overview.md" }] };
      if (method === "execution.inspect-worktree") return params.operation === "tree"
        ? { kind: "tree", files: [".alignyard/docs/shared/overview.md"] }
        : { kind: params.operation, path: params.path };
      if (method === "change-request.create") return { number: 7, url: "https://github.com/team/example/pull/7", state: "open" };
      if (method === "change-request.merge") return { number: 7, url: "https://github.com/team/example/pull/7", state: "merged" };
      if (method === "repository.refresh-protocol") return { state: "ready", error: null };
      return { ok: true };
    },
  };
  return { db, repository, task, calls, env: { db, gateway: gateway as any } };
}

test("Runner workflow completes author, review, pull request and merge without cloud checkout", async () => {
  const { db, task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };

  const started = await startTaskOnRunner(env, task.key, author, "codex");
  assert.equal(started.runtime_created, true);
  assert.equal(started.task.runner_id, "author-runner");
  const authorStart = calls.find((call) => call.method === "execution.start")!;
  assert.equal(authorStart.params.env, undefined);
  assert.equal(authorStart.params.base_branch, "main", "the selected base branch is dispatched to the Runner");
  assert.equal(authorStart.params.repository.git_url, "git@github.com:team/example.git");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }).count, 0);

  const submitted = await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  assert.equal(submitted.status, "review");
  assert.ok(submitted.repositories[0].remote_pushed_at);
  assert.ok(calls.some((call) => call.method === "execution.prepare-review"));

  const reviewStarted = await startReviewOnRunner(
    env, task.key, reviewer, "claude",
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
  const reviewerPreparation = calls.filter((call) => call.method === "execution.prepare-review").at(-1)!;
  assert.equal(reviewerPreparation.params.allow_unchanged, true);
  assert.equal(reviewerPreparation.params.push_branch, "change/ay-001/author");

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
    startTaskOnRunner(env, task.key, actor, "codex"),
    /response lost/,
  );
  const failedCall = calls.find((call) => call.method === "execution.start")!;
  assert.match(failedCall.params.work_branch, /^change\/ay-001\//);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM platform_runner_executions").get() as { count: number }).count, 1);

  const retried = await startTaskOnRunner(env, task.key, actor, "codex");
  assert.equal(retried.task.runtime_task_id, 77);
  const startCalls = calls.filter((call) => call.method === "execution.start");
  assert.equal(startCalls.length, 2);
  assert.equal(startCalls[0].params.execution_id, startCalls[1].params.execution_id);
  assert.equal(startCalls[0].params.work_branch, startCalls[1].params.work_branch);
});

test("changes requested resumes the sticky Author execution and delivers feedback", async () => {
  const { task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };
  await startTaskOnRunner(env, task.key, author, "codex");
  await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });

  await decideReviewOnRunner(env, task.key, reviewer, "changes_requested", "请补测试");
  const resumed = await startTaskOnRunner(env, task.key, author, "codex");
  assert.equal(resumed.runtime_created, false);
  assert.ok(calls.some((call) => call.method === "execution.resume"));
  assert.match(calls.find((call) => call.method === "execution.message")?.params.message || "", /请补测试/);
});

test("ordinary Task produces a reviewed design baseline and stops before PR creation", async () => {
  const { db, repository, calls, env } = fixture();
  setPlatformRepositoryProtocolState(db, repository.id, "ready");
  const task = createPlatformTask(db, {
    title: "统一登录行为",
    description: "把原始需求整理成可实现的知识设计包",
    owner: "Author",
    owner_user_id: 1,
    repositories: [{ repository_id: repository.id, mode: "editable" }],
  });
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };

  await startTaskOnRunner(env, task.key, author, "codex");
  const start = calls.filter((call) => call.method === "execution.start").at(-1)!;
  assert.match(start.params.prompt, /本次默认目标不是编码/);
  assert.match(start.params.prompt, /直接在当前会话向用户提问/);
  assert.match(start.params.prompt, /Plan 是可选的/);

  await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  const approved = await decideReviewOnRunner(env, task.key, reviewer, "approved");
  assert.equal(approved.status, "approved");
  assert.equal(approved.repositories[0].design_commit, "head-sha");
  await assert.rejects(
    createChangeRequestOnRunner(env, task.key, author),
    /普通 Task 已形成设计基线/,
  );
});

test("Repository update starts an Agent with the framework update workflow", async () => {
  const { db, repository, calls, env } = fixture();
  setPlatformRepositoryProtocolState(db, repository.id, "outdated", "v0 可更新至 v1", {
    protocol_version: 2,
    framework_version: 0,
  });
  const task = createRepositoryUpdateTask(db, repository.id, "Author", 1);

  const started = await startTaskOnRunner(env, task.key, { id: 1, name: "Author" }, "codex");
  assert.equal(started.task.task_type, "repository_update");
  const start = calls.filter((call) => call.method === "execution.start").at(-1)!;
  assert.match(start.params.prompt, /ay update --check/);
  assert.match(start.params.prompt, /不能成为重写 Repository 知识的借口/);
  assert.match(start.params.prompt, /不修改业务源码/);
});

test("ordinary Task submission depends on Runner validation and commit preparation", async () => {
  const { repository, calls, env } = fixture();
  const db = env.db;
  setPlatformRepositoryProtocolState(db, repository.id, "ready");
  const task = createPlatformTask(db, {
    title: "调整登录实现",
    owner: "Author",
    owner_user_id: 1,
    repositories: [{ repository_id: repository.id, mode: "editable" }],
  });
  const author = { id: 1, name: "Author" };
  await startTaskOnRunner(env, task.key, author, "codex");

  const submitted = await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  assert.equal(submitted.status, "review");
  assert.equal(calls.filter((call) => call.method === "execution.prepare-review").length, 1);
});

test("engineering documents are read transiently from the requesting participant's Runner", async () => {
  const { task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const reviewer = { id: 2, name: "Reviewer" };
  await startTaskOnRunner(env, task.key, author, "codex");

  const listing = await taskKnowledgeOnRunner(env, task.key, author) as { documents: Array<{ id: string }> };
  assert.equal(listing.documents[0].id, "doc.shared.overview");
  const authorCall = calls.filter((call) => call.method === "execution.knowledge").at(-1)!;
  assert.equal(authorCall.runnerId, "author-runner");

  await submitTaskForReviewOnRunner(env, task.key, author, {
    reviewer: "Reviewer", reviewer_user_id: 2, submitted_by: "Author", submitted_by_user_id: 1,
  });
  await assert.rejects(taskKnowledgeOnRunner(env, task.key, reviewer), /先启动自己的 Agent 工作区/);
  await startReviewOnRunner(env, task.key, reviewer, "claude");
  const document = await taskKnowledgeOnRunner(env, task.key, reviewer, "doc.shared.overview") as {
    document: { content: string };
  };
  assert.equal(document.document.content, "# 仓库概览");
  const reviewerCall = calls.filter((call) => call.method === "execution.knowledge").at(-1)!;
  assert.equal(reviewerCall.runnerId, "reviewer-runner");
});

test("worktree files and diffs are inspected on the requesting participant's Runner", async () => {
  const { task, calls, env } = fixture();
  const author = { id: 1, name: "Author" };
  const stranger = { id: 3, name: "Stranger" };
  await startTaskOnRunner(env, task.key, author, "codex");

  const tree = await taskWorktreeOnRunner(env, task.key, author, { operation: "tree" }) as { files: string[] };
  assert.deepEqual(tree.files, [".alignyard/docs/shared/overview.md"]);
  const call = calls.filter((item) => item.method === "execution.inspect-worktree").at(-1)!;
  assert.equal(call.runnerId, "author-runner");
  assert.equal(call.params.operation, "tree");
  assert.equal(call.params.execution_id.startsWith("rex_"), true);
  assert.equal(call.params.worktree_path, undefined, "Platform never sends a local worktree path");

  await assert.rejects(
    taskWorktreeOnRunner(env, task.key, stranger, { operation: "tree" }),
    /只有 Task 参与者/,
  );
  await assert.rejects(
    taskWorktreeOnRunner(env, task.key, author, { operation: "file" }),
    /请选择要读取的文件/,
  );
  await taskWorktreeOnRunner(env, task.key, author, { operation: "diff" });
  const completeDiff = calls.filter((item) => item.method === "execution.inspect-worktree").at(-1)!;
  assert.equal(completeDiff.params.operation, "diff");
  assert.equal(completeDiff.params.path, undefined);
});

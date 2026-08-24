import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Repo, Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import type { RepoTaskEnv } from "../task/createtask.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  getPlatformTask,
  setPlatformRepositoryProtocolState,
} from "./catalog.ts";
import {
  approveAndCreateRepositoryInitializationPullRequest,
  mergeRepositoryInitializationPullRequest,
  PlatformWorkflowError,
  repositoryInitializationPrompt,
  startRepositoryInitialization,
  submitRepositoryInitializationReview,
  type PlatformWorkflowEnv,
} from "./workflow.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function setup(options: { gitUrl?: string } = {}) {
  const gitUrl = options.gitUrl || "git@github.com:example/service.git";
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) " +
      "VALUES (7,1,'service',?,'main','/data/mirrors/7-service.git','ready')",
  ).run(gitUrl);
  const repository = createPlatformRepository(db, {
    name: "service", git_url: gitUrl, default_branch: "main", created_by: "Phil",
  });
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  let pullRequestCreated = false;
  let pullRequestMerged = false;
  const calls: string[] = [];

  const runtimeEnv: RepoTaskEnv = {
    db,
    ns: "test",
    writeManifest: () => {},
    setupWorktree: async () => BASE,
    setupReference: async () => BASE,
    startSession: async (_session, _worktree, opening, options) => {
      calls.push(`agent:${options?.agent}:${opening?.includes("不要 push")}:${options?.automated}`);
    },
    removeWorktree: async () => {},
    removeReference: async () => {},
    removeReferenceRoot: async () => {},
  };
  const runner = {
    kind: "local",
    dataDir: "/data",
    async exec(file: string, args: string[]) {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "git" && args[0] === "status") return "";
      if (file === "git" && args[0] === "rev-parse") return `${HEAD}\n`;
      if (file === "gh" && args[0] === "pr" && args[1] === "create") {
        pullRequestCreated = true;
        return "https://github.com/example/service/pull/42\n";
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
        pullRequestMerged = true;
        return "";
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        if (!pullRequestCreated) throw new Error("no pull request found");
        return JSON.stringify({
          number: 42,
          url: "https://github.com/example/service/pull/42",
          state: pullRequestMerged ? "MERGED" : "OPEN",
        });
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "create") {
        pullRequestCreated = true;
        return "https://gitlab.com/example/service/-/merge_requests/42\n";
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "merge") {
        pullRequestMerged = true;
        return "";
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "list") {
        if (!pullRequestCreated) return "[]";
        return JSON.stringify([{
          iid: 42,
          web_url: "https://gitlab.com/example/service/-/merge_requests/42",
          state: pullRequestMerged ? "merged" : "opened",
        }]);
      }
      if (file === "glab" && args[0] === "mr" && args[1] === "view") {
        if (!pullRequestCreated) throw new Error("no merge request found");
        return JSON.stringify({
          iid: 42,
          web_url: "https://gitlab.com/example/service/-/merge_requests/42",
          state: pullRequestMerged ? "merged" : "opened",
        });
      }
      return "";
    },
    async mkdirp() {},
    async exists() { return true; },
    async readText() { return null; },
    async rmrf() {},
    async putDir() {},
    async putFile() {},
  } as Runner;
  const env: PlatformWorkflowEnv = {
    db,
    root: "/app",
    runner,
    runtimeEnv,
    getLocalRepository(gitUrl) {
      return db.prepare("SELECT * FROM repos WHERE git_url=?").get(gitUrl) as Repo | undefined;
    },
    getRuntimeTask(id) {
      return db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
    },
    async stopRuntimeTask(id) { db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id); },
    async cleanupRuntimeTask(id) { db.prepare("UPDATE tasks SET status='cleaned' WHERE id=?").run(id); },
    async refreshRepository(id) {
      const updated = setPlatformRepositoryProtocolState(db, id, "ready");
      if (!updated) throw new Error("missing repository");
      return updated;
    },
  };
  return { db, env, repository, task, calls };
}

function seedSyncedOverview(db: Database.Database, key: string, repositoryId: number) {
  const task = getPlatformTask(db, key)!;
  db.prepare(
    "UPDATE platform_task_repositories SET manifest_status='valid',head_commit=? WHERE task_id=? AND repository_id=?",
  ).run(HEAD, task.id, repositoryId);
  db.prepare(
    "INSERT INTO platform_artifacts (task_id,repository_id,document_id,kind,scope,path,title) " +
      "VALUES (?,?,?,'doc','shared','.alignyard/docs/shared/overview.md','Repository Overview')",
  ).run(task.id, repositoryId, "overview");
}

test("Repository Init prompt makes agent execution automatic but keeps push and PR behind confirmation", () => {
  const { task } = setup();
  const prompt = repositoryInitializationPrompt({ root: "/app", task, platformUrl: "http://localhost:14580" });
  assert.match(prompt, /node_modules\/\.bin\/tsx/);
  assert.match(prompt, /init \./);
  assert.match(prompt, /validate \./);
  assert.match(prompt, /sync \./);
  assert.match(prompt, /不要 push/);
  assert.match(prompt, /不要创建或合并 PR/);
});

test("Repository Init closes runtime, Review, PR, merge, cleanup, and ready state", async () => {
  const { db, env, repository, task, calls } = setup();
  const started = await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  assert.equal(started.created, true);
  assert.equal(started.task.runtime_task_id, started.runtime.id);
  assert.equal(started.runtime.work_branch, "change/ay-001/phil");
  assert.ok(calls.includes("agent:codex:true:true"));

  seedSyncedOverview(db, task.key, repository.id);
  const review = await submitRepositoryInitializationReview(env, task.key);
  assert.equal(review.status, "review");
  assert.equal(review.runtime_status, "cleaned");

  const approved = await approveAndCreateRepositoryInitializationPullRequest(env, task.key);
  assert.equal(approved.status, "approved");
  assert.equal(approved.pr_number, 42);
  assert.equal(approved.pr_state, "open");
  assert.match(approved.pr_url || "", /pull\/42/);

  const merged = await mergeRepositoryInitializationPullRequest(env, task.key);
  assert.equal(merged.task.pr_state, "merged");
  assert.equal(merged.repository.protocol_state, "ready");
  assert.ok(calls.some((call) => call.startsWith("git push --set-upstream origin change/ay-001/phil")));
  assert.ok(calls.some((call) => call === "gh pr merge 42 --merge"));
});

test("GitLab Repository Init uses local glab for MR creation and merge", async () => {
  const { db, env, repository, task, calls } = setup({ gitUrl: "git@gitlab.com:example/service.git" });
  await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  seedSyncedOverview(db, task.key, repository.id);
  await submitRepositoryInitializationReview(env, task.key);

  const approved = await approveAndCreateRepositoryInitializationPullRequest(env, task.key);
  assert.equal(approved.status, "approved");
  assert.equal(approved.pr_number, 42);
  assert.match(approved.pr_url || "", /merge_requests\/42/);

  const merged = await mergeRepositoryInitializationPullRequest(env, task.key);
  assert.equal(merged.task.pr_state, "merged");
  assert.ok(calls.some((call) => call.startsWith("glab mr create --source-branch change/ay-001/phil --target-branch main")));
  assert.ok(calls.some((call) => call === "glab mr merge 42 --auto-merge=false --yes"));
  assert.equal(calls.some((call) => call.startsWith("gh pr")), false);
});

test("Repository Init start is idempotent while its runtime worktree exists", async () => {
  const { env, task } = setup();
  const first = await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  const second = await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  assert.equal(second.created, false);
  assert.equal(second.runtime.id, first.runtime.id);
});

test("concurrent Repository Init starts share one runtime and worktree", async () => {
  const { db, env, task } = setup();
  const setupWorktree = env.runtimeEnv.setupWorktree;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let worktrees = 0;
  env.runtimeEnv.setupWorktree = async (args) => {
    worktrees += 1;
    await gate;
    return setupWorktree(args);
  };

  const firstStart = startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  const secondStart = startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  release();
  const [first, second] = await Promise.all([firstStart, secondStart]);

  assert.equal(worktrees, 1);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.runtime.id, first.runtime.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count, 1);
});

test("concurrent PR confirmations share one local forge operation", async () => {
  const { db, env, repository, task } = setup();
  await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  seedSyncedOverview(db, task.key, repository.id);
  await submitRepositoryInitializationReview(env, task.key);

  const originalExec = env.runner.exec.bind(env.runner);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const createStarted = new Promise<void>((resolve) => { started = resolve; });
  let creates = 0;
  env.runner.exec = async (file, args, options) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "create") {
      creates += 1;
      started();
      await gate;
    }
    return originalExec(file, args, options);
  };

  const first = approveAndCreateRepositoryInitializationPullRequest(env, task.key);
  await createStarted;
  const second = approveAndCreateRepositoryInitializationPullRequest(env, task.key);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(creates, 1);
  assert.equal(firstResult.pr_number, 42);
  assert.equal(secondResult.pr_number, 42);
});

test("PR creation reconciles a remote success reported as already existing", async () => {
  const { db, env, repository, task } = setup();
  await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  seedSyncedOverview(db, task.key, repository.id);
  await submitRepositoryInitializationReview(env, task.key);

  const originalExec = env.runner.exec.bind(env.runner);
  env.runner.exec = async (file, args, options) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "create") {
      await originalExec(file, args, options);
      const error = new Error("create returned after remote side effect") as Error & { stderr: string };
      error.stderr = "a pull request already exists: https://github.com/example/service/pull/42";
      throw error;
    }
    return originalExec(file, args, options);
  };

  const approved = await approveAndCreateRepositoryInitializationPullRequest(env, task.key);
  assert.equal(approved.status, "approved");
  assert.equal(approved.pr_number, 42);
  assert.equal(approved.workflow_error, null);
});

test("merge reconciles a remote success reported as a local CLI error", async () => {
  const { db, env, repository, task } = setup();
  await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  seedSyncedOverview(db, task.key, repository.id);
  await submitRepositoryInitializationReview(env, task.key);
  await approveAndCreateRepositoryInitializationPullRequest(env, task.key);

  const originalExec = env.runner.exec.bind(env.runner);
  env.runner.exec = async (file, args, options) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
      await originalExec(file, args, options);
      const error = new Error("connection closed after merge") as Error & { stderr: string };
      error.stderr = "remote command status unavailable";
      throw error;
    }
    return originalExec(file, args, options);
  };

  const merged = await mergeRepositoryInitializationPullRequest(env, task.key);
  assert.equal(merged.task.pr_state, "merged");
  assert.equal(merged.repository.protocol_state, "ready");
  assert.equal(merged.task.workflow_error, null);
});

test("Repository Init can finish protocol refresh after the PR merged even if its worktree is gone", async () => {
  const { db, env, repository, task } = setup();
  await startRepositoryInitialization(env, task.key, "http://localhost:14580", "codex");
  seedSyncedOverview(db, task.key, repository.id);
  await submitRepositoryInitializationReview(env, task.key);
  await approveAndCreateRepositoryInitializationPullRequest(env, task.key);

  env.refreshRepository = async (id) => {
    const updated = setPlatformRepositoryProtocolState(db, id, "uninitialized");
    if (!updated) throw new Error("missing repository");
    return updated;
  };
  await assert.rejects(
    () => mergeRepositoryInitializationPullRequest(env, task.key),
    (error: unknown) => error instanceof PlatformWorkflowError && /默认分支/.test(error.message),
  );
  assert.equal(getPlatformTask(db, task.key)?.pr_state, "merged");
  assert.match(getPlatformTask(db, task.key)?.workflow_error || "", /默认分支/);

  env.getRuntimeTask = () => undefined;
  env.refreshRepository = async (id) => {
    const updated = setPlatformRepositoryProtocolState(db, id, "ready");
    if (!updated) throw new Error("missing repository");
    return updated;
  };
  const retried = await mergeRepositoryInitializationPullRequest(env, task.key);
  assert.equal(retried.repository.protocol_state, "ready");
  assert.equal(retried.task.workflow_error, null);
});

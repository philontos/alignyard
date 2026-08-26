import fs from "node:fs";
import path from "node:path";
import { db, type Repo, type Task } from "../core/db.js";
import { DATA_DIR, NS } from "../core/paths.js";
import { getOwnedRepo, getOwnedTask, listOwnedTasks, localHostId } from "../core/ownership.js";
import { localExecutor } from "../core/local-executor.js";
import { syncReposManifest } from "../repo/manifest.js";
import { findRepoByGitUrl } from "../repo/catalog.js";
import { registerOwnedRepo, branchesForOwnedRepo, type OwnedRepoEnv } from "../repo/owned.js";
import { buildRepoTaskEnv } from "../repo/repoenv.js";
import { createRepoTask, stopTask } from "../task/createtask.js";
import { cleanupTask, resumeTask } from "../task/lifecycle.js";
import { removeTaskManifest, writeTaskManifestFromDb } from "../task/taskmanifest.js";
import { referenceRootPath, referenceWorktreePaths } from "../task/references.js";
import { removeWorktree } from "../repo/git.js";
import { readRemoteBranchFiles } from "../repo/git.js";
import { asAgentKind } from "../session/agent.js";
import { hasSession, killSession, pasteSubmit, startSession } from "../session/tmux.js";
import { runAy } from "../protocol/cli.js";
import {
  closeChangeRequest,
  createChangeRequest,
  findChangeRequest,
  mergeChangeRequest,
  resolveForge,
  type ChangeRequestInput,
} from "../platform/forge.js";
import type { RunnerRpcMethod } from "./protocol.js";
import {
  ALIGNYARD_MANIFEST,
  REQUIRED_BOOTSTRAP_FILES,
  parseRepositoryManifest,
} from "../protocol/repository.js";

function writeManifest(id: number) {
  writeTaskManifestFromDb(DATA_DIR, db, id);
}

const ownedRepoEnv: OwnedRepoEnv = {
  db,
  runner: localExecutor,
  syncRepos: syncReposManifest,
  removeTaskManifest: (id) => removeTaskManifest(DATA_DIR, id),
  killSession: (session) => killSession(localExecutor, session),
  syncTaskManifest: writeManifest,
  removeReferenceRoot: (id) => localExecutor.rmrf(referenceRootPath(DATA_DIR, id)),
};

function repoTaskEnv() {
  return buildRepoTaskEnv({ db, ns: NS, runner: localExecutor, writeManifest });
}

function requiredObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runner 请求格式无效");
  return value as Record<string, any>;
}

function executionId(params: Record<string, any>): string {
  const value = String(params.execution_id || "").trim();
  if (!/^rex_[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Runner execution ID 无效");
  return value;
}

function executionSecretDir(id: string): string {
  return path.join(DATA_DIR, "runner-executions", id);
}

function executionEnvironment(params: Record<string, any>): Record<string, string> | undefined {
  const source = params.env && typeof params.env === "object" ? params.env as Record<string, unknown> : {};
  const allowed = ["AY_PLATFORM_URL", "AY_TASK_KEY", "AY_REPOSITORY_ID", "AY_BASE_COMMIT"];
  const result = Object.fromEntries(allowed.flatMap((key) =>
    typeof source[key] === "string" && source[key] ? [[key, source[key] as string]] : [],
  ));
  const token = typeof source.AY_PLATFORM_TOKEN === "string" ? source.AY_PLATFORM_TOKEN.trim() : "";
  if (token) {
    const directory = executionSecretDir(executionId(params));
    const target = path.join(directory, "platform-token");
    const temporary = `${target}.tmp-${process.pid}`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    result.AY_PLATFORM_TOKEN_FILE = target;
  }
  return Object.keys(result).length ? result : undefined;
}

function bindExecution(id: string, runnerTaskId: number): void {
  db.prepare(
    "INSERT INTO runner_execution_bindings (execution_id,runner_task_id) VALUES (?,?) " +
      "ON CONFLICT(execution_id) DO UPDATE SET runner_task_id=excluded.runner_task_id,updated_at=datetime('now')",
  ).run(id, runnerTaskId);
}

function boundTask(id: string): Task | undefined {
  const binding = db.prepare(
    "SELECT runner_task_id FROM runner_execution_bindings WHERE execution_id=?",
  ).get(id) as { runner_task_id: number } | undefined;
  return binding ? getOwnedTask(db, binding.runner_task_id) : undefined;
}

async function ensureRepository(input: Record<string, any>): Promise<Repo> {
  const gitUrl = String(input.git_url || "").trim();
  const hostId = localHostId(db);
  let repository = hostId == null ? undefined : findRepoByGitUrl(db, hostId, gitUrl);
  if (!repository || repository.status !== "ready") {
    const registered = await registerOwnedRepo(ownedRepoEnv, {
      name: String(input.name || "Repository"),
      git_url: gitUrl,
      default_branch: String(input.default_branch || "main"),
    });
    if (!registered.ok) throw new Error(registered.message || `Repository 准备失败：${registered.error}`);
    repository = getOwnedRepo(db, registered.id);
  }
  if (!repository?.mirror_path || repository.status !== "ready") throw new Error("Repository 尚未就绪");
  return repository;
}

function publicTask(task: Task) {
  return {
    runner_task_id: task.id,
    session: task.session,
    status: task.status,
    work_branch: task.work_branch,
    base_commit: task.base_commit,
    agent: task.agent,
  };
}

async function startExecution(params: Record<string, any>) {
  const id = executionId(params);
  const alreadyBound = boundTask(id);
  if (alreadyBound && !["error", "cleaned"].includes(alreadyBound.status)) {
    if (alreadyBound.session && await hasSession(localExecutor, alreadyBound.session)) return publicTask(alreadyBound);
    if (alreadyBound.worktree_path) return resumeExecution(alreadyBound.id, params);
  }
  const repository = await ensureRepository(requiredObject(params.repository));
  const requestedBranch = String(params.work_branch || "").trim();
  const recoverable = requestedBranch
    ? listOwnedTasks(db).find((task) =>
      task.repo_id === repository.id
      && task.work_branch === requestedBranch
      && !["error", "cleaned"].includes(task.status),
    )
    : undefined;
  if (recoverable) {
    bindExecution(id, recoverable.id);
    if (recoverable.session && await hasSession(localExecutor, recoverable.session)) return publicTask(recoverable);
    if (recoverable.worktree_path) return resumeExecution(recoverable.id, params);
  }
  const result = await createRepoTask(
    repoTaskEnv(),
    { id: repository.id, name: repository.name, mirror_path: repository.mirror_path! },
    {
      baseBranch: String(params.base_branch || repository.default_branch || "main"),
      workBranch: String(params.work_branch || "") || null,
      title: String(params.title || params.task_key || "Alignyard Task"),
      prompt: typeof params.prompt === "string" ? params.prompt : null,
      agent: asAgentKind(params.agent),
      automated: params.automated === true,
      env: executionEnvironment(params),
    },
  );
  if (!result.ok) {
    fs.rmSync(executionSecretDir(id), { recursive: true, force: true });
    throw new Error(result.message);
  }
  const task = getOwnedTask(db, result.id);
  if (!task) {
    fs.rmSync(executionSecretDir(id), { recursive: true, force: true });
    throw new Error("Runner Task 创建后未找到");
  }
  bindExecution(id, task.id);
  return publicTask(task);
}

async function resumeExecution(id: number, params: Record<string, any>) {
  const result = await resumeTask({
    db,
    exists: (target) => localExecutor.exists(target),
    hasSession: (session) => hasSession(localExecutor, session),
    startSession: async (task) => startSession(localExecutor, task.session, task.worktree_path, null, {
      continue: true,
      agent: asAgentKind(task.agent),
      model: task.agent_model,
      addDirs: referenceWorktreePaths(db, task.id),
      automated: true,
      env: executionEnvironment(params),
    }),
    writeManifest,
  }, id);
  if (!result.ok) throw new Error(result.message || result.error);
  const task = getOwnedTask(db, id);
  if (!task) throw new Error("Runner Task 不存在");
  return publicTask(task);
}

async function cleanupExecution(params: Record<string, any>) {
  const id = Number(params.runner_task_id);
  const result = await cleanupTask({
    db,
    killSession: (session) => killSession(localExecutor, session),
    removeWorktree: (mirror, worktree, branch) => removeWorktree(localExecutor, mirror, worktree, branch),
    removeReferenceRoot: (taskId) => localExecutor.rmrf(referenceRootPath(DATA_DIR, taskId)),
    writeManifest,
  }, id);
  if (!result.ok) throw new Error(result.message || result.error);
  fs.rmSync(executionSecretDir(executionId(params)), { recursive: true, force: true });
  return { ok: true };
}

async function prepareReview(params: Record<string, any>) {
  const id = Number(params.runner_task_id);
  const task = getOwnedTask(db, id);
  if (!task?.worktree_path) throw new Error("Runner Task worktree 不存在");
  const messages: string[] = [];
  const validated = await runAy(["validate", task.worktree_path], {
    out() {},
    err(message) { messages.push(message); },
  });
  if (validated !== 0) throw new Error(`ay validate 未通过：${messages.join("；") || "请检查工程知识"}`);
  const dirty = (await localExecutor.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: task.worktree_path,
  })).trim();
  if (dirty) throw new Error("worktree 仍有未提交变更");
  const head = (await localExecutor.exec("git", ["rev-parse", "HEAD"], { cwd: task.worktree_path })).trim();
  if (!head || head === task.base_commit) throw new Error("Task 尚未产生可评审的提交");
  await localExecutor.exec("git", ["push", "--set-upstream", "origin", task.work_branch], {
    cwd: task.worktree_path,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  await stopTask({
    db,
    killSession: (session) => killSession(localExecutor, session),
    writeManifest,
  }, id);
  return { ...publicTask(getOwnedTask(db, id)!), head_commit: head };
}

function changeRequestInput(params: Record<string, any>): ChangeRequestInput & Record<string, any> {
  const task = getOwnedTask(db, Number(params.runner_task_id));
  if (!task?.worktree_path) throw new Error("Runner Task worktree 不存在");
  const repository = getOwnedRepo(db, task.repo_id);
  if (!repository) throw new Error("Runner Repository 不存在");
  return {
    runner: localExecutor,
    cwd: task.worktree_path,
    gitUrl: repository.git_url,
    baseBranch: String(params.base_branch || task.base_branch),
    headBranch: String(params.head_branch || task.work_branch),
    title: String(params.title || task.title),
    body: String(params.body || ""),
  };
}

export async function executeRunnerRpc(method: RunnerRpcMethod, rawParams: unknown): Promise<unknown> {
  const params = requiredObject(rawParams);
  if (method === "execution.start") return startExecution(params);
  if (method === "execution.status") {
    const task = getOwnedTask(db, Number(params.runner_task_id));
    if (!task) throw new Error("Runner Task 不存在");
    const headCommit = task.worktree_path
      ? await localExecutor.exec("git", ["rev-parse", "HEAD"], { cwd: task.worktree_path }).then((value) => value.trim()).catch(() => null)
      : null;
    return { ...publicTask(task), alive: await hasSession(localExecutor, task.session), head_commit: headCommit };
  }
  if (method === "execution.resume") return resumeExecution(Number(params.runner_task_id), params);
  if (method === "execution.stop") {
    const result = await stopTask({
      db,
      killSession: (session) => killSession(localExecutor, session),
      writeManifest,
    }, Number(params.runner_task_id));
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  }
  if (method === "execution.cleanup") return cleanupExecution(params);
  if (method === "execution.message") {
    const task = getOwnedTask(db, Number(params.runner_task_id));
    if (!task?.session) throw new Error("Runner Task session 不存在");
    await pasteSubmit(localExecutor, task.session, String(params.message || ""));
    return { ok: true };
  }
  if (method === "execution.prepare-review") return prepareReview(params);
  if (method === "repository.branches") {
    const repository = await ensureRepository(requiredObject(params.repository));
    const result = await branchesForOwnedRepo(ownedRepoEnv, repository.id);
    if (!result.ok) throw new Error(result.message || result.error);
    return result;
  }
  if (method === "repository.refresh-protocol") {
    const input = requiredObject(params.repository);
    const repository = await ensureRepository(input);
    const branch = String(input.default_branch || repository.default_branch || "main");
    const files = await readRemoteBranchFiles(
      localExecutor,
      repository.mirror_path!,
      branch,
      REQUIRED_BOOTSTRAP_FILES,
    );
    const manifestText = files[ALIGNYARD_MANIFEST];
    if (!manifestText) return { state: "uninitialized", error: null };
    const parsed = parseRepositoryManifest(manifestText);
    if (!parsed.manifest) return { state: "invalid", error: parsed.errors.join("\n") };
    const missing = REQUIRED_BOOTSTRAP_FILES.filter((filePath) => files[filePath] == null);
    return missing.length
      ? { state: "invalid", error: `默认分支缺少初始化文件：${missing.join("、")}` }
      : { state: "ready", error: null };
  }
  if (method === "capabilities.refresh") return { ok: true };
  if (method.startsWith("change-request.")) {
    const input = changeRequestInput(params);
    const kind = await resolveForge(input);
    if (method === "change-request.create") return createChangeRequest(kind, input as any);
    const current = await findChangeRequest(kind, input, Number(params.number) || undefined);
    if (method === "change-request.refresh") return current;
    if (!current) throw new Error("合并请求不存在");
    if (method === "change-request.merge") return mergeChangeRequest(kind, input, current.number);
    if (method === "change-request.close") return closeChangeRequest(kind, input, current.number);
  }
  throw new Error(`Runner 不支持操作：${method}`);
}

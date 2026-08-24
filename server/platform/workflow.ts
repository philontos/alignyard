import path from "node:path";
import type Database from "better-sqlite3";
import type { Repo, Task } from "../core/db.js";
import type { Runner } from "../fleet/runner.js";
import type { AgentKind } from "../session/agent.js";
import { createRepoTask, type RepoTaskEnv } from "../task/createtask.js";
import {
  getPlatformTask,
  linkPlatformTaskRuntime,
  markPlatformPullRequestMerged,
  recordPlatformPullRequest,
  setPlatformTaskWorkflowError,
  updatePlatformTaskCommits,
  updatePlatformTaskStatus,
  type PlatformRepository,
  type PlatformTask,
} from "./catalog.js";

type DB = Database.Database;

export class PlatformWorkflowError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlatformWorkflowError";
  }
}

function errorMessage(error: unknown): string {
  return String((error as any)?.stderr || (error as any)?.message || error).trim();
}

export interface PlatformWorkflowEnv {
  db: DB;
  root: string;
  runner: Runner;
  runtimeEnv: RepoTaskEnv;
  getLocalRepository(gitUrl: string): Repo | undefined;
  getRuntimeTask(id: number): Task | undefined;
  stopRuntimeTask(id: number): Promise<void>;
  cleanupRuntimeTask(id: number): Promise<void>;
  refreshRepository(id: number): Promise<PlatformRepository>;
}

interface PullRequestInfo {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
}

function initTask(env: PlatformWorkflowEnv, key: string): PlatformTask {
  const task = getPlatformTask(env.db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  if (task.task_type !== "repository_init") throw new PlatformWorkflowError(409, "当前 Task 不是 Repository 初始化任务");
  return task;
}

function editableRepository(task: PlatformTask) {
  const repository = task.repositories.find((item) => item.mode === "editable");
  if (!repository) throw new PlatformWorkflowError(409, "初始化 Task 缺少 editable Repository");
  return repository;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function repositoryInitializationPrompt(input: {
  root: string;
  task: PlatformTask;
  platformUrl: string;
}): string {
  const repository = editableRepository(input.task);
  const tsx = path.join(input.root, "node_modules", ".bin", "tsx");
  const entry = path.join(input.root, "server", "ay.ts");
  const ay = `${shellArg(tsx)} ${shellArg(entry)}`;
  return `你正在执行 Alignyard 平台的 Repository 初始化 Task ${input.task.key}。

目标：只在当前 Task worktree 中为 ${repository.name} 建立准确、最小、可评审的版本化工程知识。

请自主完成以下流程，不要等待用户逐条确认：
1. 运行 ${ay} init .
2. 运行 ${ay} new doc overview --scope shared --title "Repository Overview"
3. 阅读仓库的 README、package metadata、主要目录和关键入口；按生成的 alignyard-knowledge Skill 更新 scopes，并把 overview 写成对本仓库真实有用的说明。不要编造事实。
4. 只修改 .alignyard/。运行 ${ay} validate .，修复全部问题。
5. 运行 git add .alignyard && git commit -m "docs: initialize Alignyard knowledge"。如果 Git 身份缺失，使用当前仓库已有的 author 配置；不要改全局配置。
6. 提交后运行 ${ay} sync . --platform ${shellArg(input.platformUrl)} --task ${input.task.key} --repository-id ${repository.id} --base-commit "$(git merge-base HEAD ${shellArg(`origin/${repository.base_branch}`)})"。
7. 最后确认 git status --short 为空，并总结生成的 scopes、Docs、Specs、ADRs 和验证结果。

边界：不要修改业务源代码，不要 push，不要创建或合并 PR，不要修改 ${repository.base_branch}。Review、push、PR 和 merge 由平台在人工确认后执行。`;
}

export async function startRepositoryInitialization(
  env: PlatformWorkflowEnv,
  key: string,
  platformUrl: string,
  agent: AgentKind = "codex",
): Promise<{ task: PlatformTask; runtime: Task; created: boolean }> {
  let task = initTask(env, key);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态的初始化 Task 可以启动 Agent");
  const repository = editableRepository(task);
  setPlatformTaskWorkflowError(env.db, key, null);
  try {
    if (task.runtime_task_id) {
      const existing = env.getRuntimeTask(task.runtime_task_id);
      if (existing?.worktree_path) return { task, runtime: existing, created: false };
    }

    const local = env.getLocalRepository(repository.git_url);
    if (!local?.mirror_path || local.status !== "ready") {
      throw new PlatformWorkflowError(409, "本机 Repository 尚未就绪，无法创建初始化 worktree");
    }

    const prompt = repositoryInitializationPrompt({ root: env.root, task, platformUrl });
    const result = await createRepoTask(
      env.runtimeEnv,
      { id: local.id, name: local.name, mirror_path: local.mirror_path },
      {
        baseBranch: repository.base_branch,
        workBranch: repository.work_branch,
        title: `[${task.key}] Initialize ${repository.name}`,
        prompt,
        agent,
        env: {
          AY_PLATFORM_URL: platformUrl,
          AY_TASK_KEY: task.key,
          AY_REPOSITORY_ID: String(repository.id),
        },
      },
    );
    if (!result.ok && result.error === "invalidReference") {
      throw new PlatformWorkflowError(400, result.message);
    }
    const runtime = env.getRuntimeTask(result.id);
    if (runtime) {
      task = linkPlatformTaskRuntime(env.db, key, {
        id: runtime.id,
        work_branch: runtime.work_branch || repository.work_branch || "",
        base_commit: runtime.base_commit,
      }) || task;
    }
    if (!result.ok || !runtime) {
      const message = result.ok ? "runtime Task 创建后未找到" : result.message;
      throw new PlatformWorkflowError(500, `初始化 Agent 启动失败：${message}`);
    }
    return { task, runtime, created: true };
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

async function repositoryHead(env: PlatformWorkflowEnv, task: PlatformTask): Promise<{
  runtime: Task;
  repository: ReturnType<typeof editableRepository>;
  head: string;
}> {
  const repository = editableRepository(task);
  if (!task.runtime_task_id) throw new PlatformWorkflowError(409, "初始化 Agent 尚未启动");
  const runtime = env.getRuntimeTask(task.runtime_task_id);
  if (!runtime?.worktree_path || !(await env.runner.exists(runtime.worktree_path))) {
    throw new PlatformWorkflowError(409, "初始化 worktree 不存在");
  }
  const dirty = (await env.runner.exec("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: runtime.worktree_path,
  })).trim();
  if (dirty) throw new PlatformWorkflowError(409, "worktree 仍有未提交变更，请让 Agent 完成提交和 sync");
  const head = (await env.runner.exec("git", ["rev-parse", "HEAD"], { cwd: runtime.worktree_path })).trim();
  if (!head || head === runtime.base_commit) throw new PlatformWorkflowError(409, "初始化尚未产生可评审的提交");
  if (repository.head_commit !== head) {
    throw new PlatformWorkflowError(409, "最新提交尚未 sync，请让 Agent 重新执行 ay sync");
  }
  return { runtime, repository, head };
}

export async function submitRepositoryInitializationReview(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  const task = initTask(env, key);
  if (task.status !== "draft") throw new PlatformWorkflowError(409, "只有草稿状态可以提交 Review");
  try {
    const { runtime, head } = await repositoryHead(env, task);
    updatePlatformTaskCommits(env.db, key, { base_commit: runtime.base_commit, head_commit: head });
    await env.stopRuntimeTask(runtime.id);
    const updated = updatePlatformTaskStatus(env.db, key, "review");
    if (!updated) throw new PlatformWorkflowError(404, "Task 不存在");
    setPlatformTaskWorkflowError(env.db, key, null);
    return getPlatformTask(env.db, key) || updated;
  } catch (error) {
    setPlatformTaskWorkflowError(env.db, key, errorMessage(error));
    throw error;
  }
}

function pullRequestInfo(raw: string): PullRequestInfo {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new PlatformWorkflowError(502, "无法解析 GitHub PR 响应"); }
  const number = Number(value?.number);
  const url = typeof value?.url === "string" ? value.url : "";
  const stateValue = String(value?.state || "").toLowerCase();
  const state = stateValue === "merged" ? "merged" : stateValue === "closed" ? "closed" : "open";
  if (!Number.isInteger(number) || number <= 0 || !url) throw new PlatformWorkflowError(502, "GitHub PR 响应缺少 number 或 url");
  return { number, url, state };
}

async function findPullRequest(env: PlatformWorkflowEnv, worktree: string, branch: string): Promise<PullRequestInfo | null> {
  try {
    const output = await env.runner.exec("gh", ["pr", "view", branch, "--json", "number,url,state"], { cwd: worktree });
    return pullRequestInfo(output);
  } catch {
    return null;
  }
}

export async function approveAndCreateRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<PlatformTask> {
  let task = initTask(env, key);
  if (task.status !== "review" && task.status !== "approved") {
    throw new PlatformWorkflowError(409, "Task 需要先进入 Review");
  }
  try {
    const { runtime, repository } = await repositoryHead(env, task);
    if (task.pr_state === "merged" || task.pr_state === "closed") {
      throw new PlatformWorkflowError(409, `PR 已${task.pr_state === "merged" ? "合并" : "关闭"}`);
    }
    await env.runner.exec("git", ["push", "--set-upstream", "origin", repository.work_branch || runtime.work_branch], {
      cwd: runtime.worktree_path,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    let pullRequest = await findPullRequest(env, runtime.worktree_path, repository.work_branch || runtime.work_branch);
    if (!pullRequest) {
      const body = [
        `Alignyard initialization for ${repository.name}.`,
        "",
        `Platform Task: ${task.key}`,
        `Knowledge artifacts: ${task.artifacts.length}`,
        "",
        "Prepared by the Repository Init workflow after local validation and platform sync.",
      ].join("\n");
      await env.runner.exec("gh", [
        "pr", "create",
        "--base", repository.base_branch,
        "--head", repository.work_branch || runtime.work_branch,
        "--title", `[${task.key}] Initialize Alignyard knowledge`,
        "--body", body,
      ], { cwd: runtime.worktree_path });
      pullRequest = await findPullRequest(env, runtime.worktree_path, repository.work_branch || runtime.work_branch);
    }
    if (!pullRequest) throw new PlatformWorkflowError(502, "PR 创建后未找到");
    recordPlatformPullRequest(env.db, key, pullRequest);
    if (task.status === "review") updatePlatformTaskStatus(env.db, key, "approved");
    task = getPlatformTask(env.db, key) || task;
    return task;
  } catch (error: any) {
    const message = errorMessage(error);
    setPlatformTaskWorkflowError(env.db, key, message);
    if (error instanceof PlatformWorkflowError) throw error;
    throw new PlatformWorkflowError(502, `创建 PR 失败：${message}`);
  }
}

export async function mergeRepositoryInitializationPullRequest(
  env: PlatformWorkflowEnv,
  key: string,
): Promise<{ task: PlatformTask; repository: PlatformRepository; cleanup_warning?: string }> {
  let task = initTask(env, key);
  if (task.status !== "approved" || !task.pr_number) {
    throw new PlatformWorkflowError(409, "需要先批准 Review 并创建 PR");
  }
  const repository = editableRepository(task);
  const runtime = task.runtime_task_id ? env.getRuntimeTask(task.runtime_task_id) : undefined;

  try {
    if (task.pr_state !== "merged") {
      if (!runtime?.worktree_path || !(await env.runner.exists(runtime.worktree_path))) {
        throw new PlatformWorkflowError(409, "初始化 worktree 不存在");
      }
      await env.runner.exec("gh", ["pr", "merge", String(task.pr_number), "--merge"], { cwd: runtime.worktree_path });
      const output = await env.runner.exec("gh", [
        "pr", "view", String(task.pr_number), "--json", "number,url,state",
      ], { cwd: runtime.worktree_path });
      const pullRequest = pullRequestInfo(output);
      if (pullRequest.state !== "merged") throw new PlatformWorkflowError(409, "PR 尚未合并");
      recordPlatformPullRequest(env.db, key, pullRequest);
      markPlatformPullRequestMerged(env.db, key);
      task = getPlatformTask(env.db, key) || task;
    }

    const refreshed = await env.refreshRepository(repository.id);
    if (refreshed.protocol_state !== "ready") {
      throw new PlatformWorkflowError(409, refreshed.protocol_error || "PR 已合并，但默认分支尚未通过初始化检查");
    }
    setPlatformTaskWorkflowError(env.db, key, null);

    let cleanupWarning: string | undefined;
    if (runtime?.worktree_path && await env.runner.exists(runtime.worktree_path).catch(() => false)) {
      await env.runner.exec("git", ["push", "origin", "--delete", repository.work_branch || runtime.work_branch], {
        cwd: runtime.worktree_path,
        env: { GIT_TERMINAL_PROMPT: "0" },
      }).catch(() => {});
      try { await env.cleanupRuntimeTask(runtime.id); } catch (error: any) {
        cleanupWarning = errorMessage(error);
        setPlatformTaskWorkflowError(env.db, key, `PR 已合并，但清理 worktree 失败：${cleanupWarning}`);
      }
    }
    return { task: getPlatformTask(env.db, key) || task, repository: refreshed, cleanup_warning: cleanupWarning };
  } catch (error: any) {
    const message = errorMessage(error);
    setPlatformTaskWorkflowError(env.db, key, message);
    if (error instanceof PlatformWorkflowError) throw error;
    throw new PlatformWorkflowError(502, `合并 PR 失败：${message}`);
  }
}

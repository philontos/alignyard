import type { Express, Request } from "express";
import { db } from "../core/db.js";
import { asAgentKind } from "../session/agent.js";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  createPlatformTask,
  deletePlatformRepository,
  getPlatformRepository,
  getPlatformTask,
  listPlatformMembers,
  listPlatformRepositories,
  listPlatformTasks,
  platformRepositoryTaskCount,
  PlatformValidationError,
  updatePlatformTaskStatus,
  type PlatformRepository,
  type PlatformTask,
} from "../platform/catalog.js";
import { PlatformWorkflowError } from "../platform/errors.js";
import { authenticatedUser, getPlatformUser } from "../auth/auth.js";

export interface PlatformRouteActor { id: number; name: string }

export interface PlatformRouteBackend {
  taskRuntime(task: PlatformTask): Promise<{ runtime_alive: boolean; runtime_has_worktree: boolean }>;
  repositoryBranches(repositoryId: number, actor: PlatformRouteActor, runnerId?: unknown): Promise<string[]>;
  deleteRepository(repository: PlatformRepository): Promise<{ local_removed: boolean }>;
  refreshRepository(repositoryId: number, actor: PlatformRouteActor, runnerId?: unknown): Promise<PlatformRepository>;
  deleteTask(key: string, actor: PlatformRouteActor): Promise<PlatformTask>;
  startTask(key: string, actor: PlatformRouteActor, agent: ReturnType<typeof asAgentKind>, runnerId?: unknown): Promise<{ task: PlatformTask; runtime_created: boolean }>;
  submitReview(key: string, actor: PlatformRouteActor, input: { reviewer: string; reviewer_user_id: number; submitted_by: string; submitted_by_user_id: number }): Promise<PlatformTask>;
  taskKnowledge(key: string, actor: PlatformRouteActor, documentId?: unknown): Promise<unknown>;
  startReview(key: string, actor: PlatformRouteActor, agent: ReturnType<typeof asAgentKind>, runnerId?: unknown): Promise<{ task: PlatformTask; runtime_created: boolean }>;
  decideReview(key: string, actor: PlatformRouteActor, decision: "approved" | "changes_requested", feedback?: unknown): Promise<PlatformTask>;
  createChangeRequest(key: string, actor: PlatformRouteActor): Promise<PlatformTask>;
  mergeChangeRequest(key: string, actor: PlatformRouteActor): Promise<{ task: PlatformTask; repository?: PlatformRepository; cleanup_warning?: string }>;
  refreshChangeRequest(key: string, actor: PlatformRouteActor): Promise<{ task: PlatformTask; repository?: PlatformRepository; cleanup_warning?: string }>;
}

function workflowActor(req: Request): PlatformRouteActor {
  const user = authenticatedUser(req);
  return { id: user.id, name: user.name };
}

function requireTaskOwner(req: Request, key: string): PlatformTask {
  const task = getPlatformTask(db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  const user = authenticatedUser(req);
  const matches = task.owner_user_id != null ? task.owner_user_id === user.id : task.owner === user.name;
  if (!matches) throw new PlatformWorkflowError(403, "只有 Task 发起人可以执行此操作");
  return task;
}

function requireTaskReviewer(req: Request, key: string): PlatformTask {
  const task = getPlatformTask(db, key);
  if (!task) throw new PlatformWorkflowError(404, "Task 不存在");
  const user = authenticatedUser(req);
  const matches = task.review?.reviewer_user_id != null
    ? task.review.reviewer_user_id === user.id
    : task.review?.reviewer === user.name;
  if (!matches) throw new PlatformWorkflowError(403, "只有指定 Reviewer 可以执行此操作");
  return task;
}

export function registerPlatformRoutes(app: Express, backend: PlatformRouteBackend) {
  const platformTaskPayload = async (task: PlatformTask) => ({ ...task, ...await backend.taskRuntime(task) });

// ---------- Alignyard shared control plane ----------
// Shared rows remain credential-free. Owner-local runtime worktrees and agents
// are orchestrated through the same node-local services as ordinary tasks.
app.get("/api/platform/repositories", (_req, res) => {
  res.json(listPlatformRepositories(db));
});

// Alignyard keeps only credential-free Repository metadata. Resolve that row
// back to this node's owned Repository, then reuse the Runner's live branch
// catalog (git ls-remote) so the browser never guesses or hand-types a ref.
app.get("/api/platform/repositories/:id/branches", async (req, res) => {
  try {
    res.json(await backend.repositoryBranches(
      Number(req.params.id), workflowActor(req), req.query.runner_id,
    ));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    return res.status(502).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/repositories", (req, res) => {
  try {
    const user = authenticatedUser(req);
    res.status(201).json(createPlatformRepository(db, {
      ...(req.body ?? {}),
      created_by: user.name,
      created_by_user_id: user.id,
    }));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.delete("/api/platform/repositories/:id", async (req, res) => {
  try {
    const repositoryId = Number(req.params.id);
    const repository = getPlatformRepository(db, repositoryId);
    if (!repository) return res.status(404).json({ error: "Repository 不存在" });
    const user = authenticatedUser(req);
    const isCreator = repository.created_by_user_id != null
      ? repository.created_by_user_id === user.id
      : repository.created_by === user.name;
    if (!isCreator) return res.status(403).json({ error: "只有 Repository 登记人可以删除" });
    const taskCount = platformRepositoryTaskCount(db, repositoryId);
    if (taskCount) {
      return res.status(409).json({ error: `Repository 已被 ${taskCount} 个 Task 引用，不能删除`, taskCount });
    }

    const removed = await backend.deleteRepository(repository);
    deletePlatformRepository(db, repositoryId);
    res.json({ ok: true, ...removed });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/repositories/:id/initialize", async (req, res) => {
  try {
    const user = authenticatedUser(req);
    const task = createRepositoryInitializationTask(db, Number(req.params.id), user.name, user.id);
    const repository = getPlatformRepository(db, Number(req.params.id));
    res.json({ task: await platformTaskPayload(task), repository, runtime_created: false });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/repositories/:id/refresh", async (req, res) => {
  try {
    res.json(await backend.refreshRepository(
      Number(req.params.id), workflowActor(req), req.body?.runner_id,
    ));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.get("/api/platform/tasks", async (_req, res) => {
  res.json(await Promise.all(listPlatformTasks(db).map(platformTaskPayload)));
});

app.get("/api/platform/members", (_req, res) => {
  res.json(listPlatformMembers(db));
});

app.get("/api/platform/tasks/:key", async (req, res) => {
  const task = getPlatformTask(db, req.params.key);
  if (!task) return res.status(404).json({ error: "Task 不存在" });
  res.json(await platformTaskPayload(task));
});

app.get("/api/platform/tasks/:key/knowledge", async (req, res) => {
  try {
    res.json(await backend.taskKnowledge(req.params.key, workflowActor(req), req.query.document_id));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks", (req, res) => {
  try {
    const repositories = Array.isArray(req.body?.repositories) ? req.body.repositories : [];
    if (repositories.length !== 1 || repositories[0]?.mode !== "editable") {
      return res.status(400).json({ error: "当前每个 Task 只支持一个 editable Repository" });
    }
    const user = authenticatedUser(req);
    res.status(201).json(createPlatformTask(db, {
      ...(req.body ?? {}),
      owner: user.name,
      owner_user_id: user.id,
    }));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.patch("/api/platform/tasks/:key", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    if (["review", "approved"].includes(req.body?.status)) {
      return res.status(409).json({ error: "请使用 Review 分派与审核结论操作流转 Task" });
    }
    if (req.body?.status === "completed") {
      const user = authenticatedUser(req);
      const current = getPlatformTask(db, req.params.key);
      if (!current) return res.status(404).json({ error: "Task 不存在" });
      const isOwner = current.owner_user_id != null
        ? current.owner_user_id === user.id
        : current.owner === user.name;
      if (!isOwner) return res.status(403).json({ error: "只有 Task 发起人可以完成 Task" });
    }
    const task = updatePlatformTaskStatus(db, req.params.key, req.body?.status);
    if (!task) return res.status(404).json({ error: "Task 不存在" });
    res.json(await platformTaskPayload(task));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.delete("/api/platform/tasks/:key", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    const task = await backend.deleteTask(req.params.key, workflowActor(req));
    res.json({ ok: true, task_key: task.key });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/run", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    const started = await backend.startTask(
      req.params.key, workflowActor(req),
      asAgentKind(req.body?.agent || "codex"), req.body?.runner_id,
    );
    res.json({ task: await platformTaskPayload(started.task), runtime_created: started.runtime_created });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/review", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    const submittedBy = authenticatedUser(req);
    const reviewerUserId = Number(req.body?.reviewer_user_id);
    const reviewer = Number.isInteger(reviewerUserId) ? getPlatformUser(db, reviewerUserId) : undefined;
    if (!reviewer || reviewer.status !== "active") {
      return res.status(400).json({ error: "请选择有效的 Reviewer" });
    }
    const reviewInput = {
      reviewer: reviewer.name,
      reviewer_user_id: reviewer.id,
      submitted_by: submittedBy.name,
      submitted_by_user_id: submittedBy.id,
    };
    const task = await backend.submitReview(
      req.params.key, { id: submittedBy.id, name: submittedBy.name }, reviewInput,
    );
    res.json(await platformTaskPayload(task));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/review/run", async (req, res) => {
  try {
    requireTaskReviewer(req, req.params.key);
    const started = await backend.startReview(
      req.params.key, workflowActor(req),
      asAgentKind(req.body?.agent || "codex"), req.body?.runner_id,
    );
    res.json({ task: await platformTaskPayload(started.task), runtime_created: started.runtime_created });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/review/decision", async (req, res) => {
  try {
    requireTaskReviewer(req, req.params.key);
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "changes_requested") {
      return res.status(400).json({ error: "Review 结论无效" });
    }
    const task = await backend.decideReview(
      req.params.key, workflowActor(req), decision, req.body?.feedback,
    );
    res.json(await platformTaskPayload(task));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/pull-request", async (req, res) => {
  try {
    const user = authenticatedUser(req);
    requireTaskOwner(req, req.params.key);
    const task = await backend.createChangeRequest(req.params.key, { id: user.id, name: user.name });
    res.json(await platformTaskPayload(task));
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/merge", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    const result = await backend.mergeChangeRequest(req.params.key, workflowActor(req));
    res.json({ ...result, task: await platformTaskPayload(result.task) });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/platform/tasks/:key/change-request/refresh", async (req, res) => {
  try {
    requireTaskOwner(req, req.params.key);
    const result = await backend.refreshChangeRequest(req.params.key, workflowActor(req));
    res.json({ ...result, task: await platformTaskPayload(result.task) });
  } catch (error: any) {
    if (error instanceof PlatformWorkflowError) return res.status(error.status).json({ error: error.message });
    if (error instanceof PlatformValidationError) return res.status(409).json({ error: error.message });
    res.status(500).json({ error: String(error?.message || error) });
  }
});

}

import { db } from "../core/db.js";
import { runnerGateway } from "../runner/gateway.js";
import {
  createChangeRequestOnRunner,
  decideReviewOnRunner,
  deleteTaskOnRunner,
  mergeChangeRequestOnRunner,
  refreshChangeRequestOnRunner,
  refreshRepositoryOnRunner,
  repositoryBranchesOnRunner,
  startReviewOnRunner,
  startTaskOnRunner,
  submitTaskForReviewOnRunner,
  taskKnowledgeOnRunner,
} from "../platform/runner-workflow.js";
import type { PlatformRouteBackend } from "./platform-routes.js";

const workflowEnv = { db, gateway: runnerGateway };

/** The only production execution adapter. HTTP depends on this small contract;
 * all Git/worktree/tmux work remains behind the authenticated Runner gateway. */
export const platformRunnerBackend: PlatformRouteBackend = {
  async taskRuntime(task) {
    if (!task.runner_execution_id || !task.runner_id) {
      return { runtime_alive: false, runtime_has_worktree: false };
    }
    const active = ["queued", "starting", "running", "waiting"].includes(task.runtime_status || "");
    const hasWorktree = task.runtime_task_id != null && !["failed", "cleaned"].includes(task.runtime_status || "");
    return {
      runtime_alive: runnerGateway.isOnline(task.runner_id) && active,
      runtime_has_worktree: hasWorktree,
    };
  },
  repositoryBranches: (repositoryId, actor, runnerId) =>
    repositoryBranchesOnRunner(workflowEnv, repositoryId, actor, runnerId),
  async deleteRepository() {
    return { local_removed: false };
  },
  refreshRepository: (repositoryId, actor, runnerId) =>
    refreshRepositoryOnRunner(workflowEnv, repositoryId, actor, runnerId),
  deleteTask: (key, actor) => deleteTaskOnRunner(workflowEnv, key, actor),
  startTask: (key, actor, agent, runnerId) =>
    startTaskOnRunner(workflowEnv, key, actor, agent, runnerId),
  submitReview: (key, actor, input) => submitTaskForReviewOnRunner(workflowEnv, key, actor, input),
  taskKnowledge: (key, actor, documentId) => taskKnowledgeOnRunner(workflowEnv, key, actor, documentId),
  startReview: (key, actor, agent, runnerId) =>
    startReviewOnRunner(workflowEnv, key, actor, agent, runnerId),
  decideReview: (key, actor, decision, feedback) =>
    decideReviewOnRunner(workflowEnv, key, actor, decision, feedback),
  createChangeRequest: (key, actor) => createChangeRequestOnRunner(workflowEnv, key, actor),
  mergeChangeRequest: (key, actor) => mergeChangeRequestOnRunner(workflowEnv, key, actor),
  refreshChangeRequest: (key, actor) => refreshChangeRequestOnRunner(workflowEnv, key, actor),
};

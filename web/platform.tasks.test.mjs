import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./platform.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./js/platform.js", import.meta.url), "utf8");
const worktree = fs.readFileSync(new URL("./js/platform-worktree.js", import.meta.url), "utf8");
const worktreeStyles = fs.readFileSync(new URL("./css/platform-worktree.css", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("./js/platform-agent.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./css/platform.css", import.meta.url), "utf8");
const platformRoutes = fs.readFileSync(new URL("../server/http/platform-routes.ts", import.meta.url), "utf8");
const platformRunnerBackend = fs.readFileSync(new URL("../server/http/platform-runner-backend.ts", import.meta.url), "utf8");
const platformApp = fs.readFileSync(new URL("../server/platform/app.ts", import.meta.url), "utf8");
const platformMain = fs.readFileSync(new URL("../server/platform/main.ts", import.meta.url), "utf8");

test("Tasks surface keeps only the three primary filters and one create action", () => {
  const taskView = html.match(/<section class="view active" id="view-tasks"[\s\S]*?<\/section>/)?.[0] || "";
  assert.deepEqual(
    [...taskView.matchAll(/data-task-filter="([^"]+)"/g)].map((match) => match[1]),
    ["all", "mine", "review"],
  );
  assert.match(taskView, /data-create-task>＋ Task<\/button>/);
  assert.doesNotMatch(taskView, /summary-grid|task-search|page-heading/);
  assert.doesNotMatch(html, /创建后生成|AY-xxx/);
  assert.match(html, /<label class="full"><span>负责人<\/span>/);
});

test("empty Tasks result renders as a quiet background without duplicate calls to action", () => {
  assert.match(script, /class="task-empty" aria-label="暂无 Task"/);
  assert.doesNotMatch(script, /创建第一个 Task|没有匹配的 Task|调整筛选条件/);
});

test("platform navigation contains only Tasks and Repositories", () => {
  assert.deepEqual(
    [...html.matchAll(/class="nav-item(?: active)?"[^>]+data-view="([^"]+)"/g)].map((match) => match[1]),
    ["tasks", "repositories"],
  );
  assert.doesNotMatch(html, /id="view-(?:reviews|knowledge)"/);
  assert.match(script, /const allowed = \["tasks", "repositories"\]/);
  assert.match(html, /data-view="repositories"[\s\S]*?<span>Repos<\/span>/);
  assert.match(html, /id="view-repositories" data-title="Repos"/);
});

test("switching a primary view closes the expanded Task workspace", () => {
  const setView = script.match(/function setView[\s\S]*?\n}\n\nfunction openMobileNav/)?.[0] || "";
  assert.match(setView, /if \(!\$\("#task-drawer"\)\.hidden\) closeTaskDetail\(\)/);
});

test("Repositories surface detects protocol state and creates lifecycle Tasks", () => {
  assert.match(script, /repositoryProtocolState/);
  assert.match(script, /state-\$\{escapeHtml\(protocolState\)\}/);
  assert.match(script, /data-init-repository/);
  assert.match(script, /openRepositoryTaskLaunch\(repositoryId, "initialize", button\)/);
  assert.match(script, /task\.task_type === "repository_init"/);
  assert.match(script, /outdated: "可更新"/);
  assert.match(script, /data-update-repository/);
  assert.match(script, /openRepositoryTaskLaunch\(repositoryId, "update", button\)/);
  assert.match(script, /task\.task_type === "repository_update"/);
  assert.match(script, /refreshRepositoryProtocolsAutomatically/);
  assert.match(html, /id="repository-task-launch-dialog"[\s\S]*name="agent"[\s\S]*创建并启动/);
  assert.match(script, /\$\{launch\.repositoryId\}\/\$\{launch\.operation\}/);
  assert.match(script, /const started = await startTaskRuntime\(task, agent\)/);
  assert.doesNotMatch(script, /已创建，请选择 Agent 启动/);
  const initializeRoute = platformRoutes.match(/app\.post\("\/api\/platform\/repositories\/:id\/initialize"[\s\S]*?app\.post\("\/api\/platform\/repositories\/:id\/refresh"/)?.[0] || "";
  assert.match(initializeRoute, /createRepositoryInitializationTask/);
  assert.match(initializeRoute, /createRepositoryUpdateTask/);
  assert.doesNotMatch(initializeRoute, /startRepositoryInitialization/);
  assert.doesNotMatch(html, /notice-card|repo-search|repository-card/);
});

test("clicking a Repository opens a compact credential-free metadata dialog", () => {
  assert.match(script, /import \{ displayGitUrl, formatRepoDate \} from "\.\/core\/repo-details\.js"/);
  assert.match(script, /class="repository-main repository-open"[^>]+data-open-repository/);
  assert.match(script, /function openRepositoryDetails/);
  assert.match(script, /repository\.forge_kind/);
  assert.match(script, /repository\.created_by/);
  assert.match(script, /repository\.protocol_error/);
  assert.match(html, /id="repository-detail-dialog"[\s\S]*role="dialog"[\s\S]*Git 地址[\s\S]*默认分支[\s\S]*初始化状态[\s\S]*关联 Tasks/);
  const dialog = html.match(/id="repository-detail-dialog"[\s\S]*?<\/section>\s*<\/div>/)?.[0] || "";
  assert.doesNotMatch(dialog, /token|mirror/i);
  assert.match(styles, /\.repository-detail-dialog\s*\{[^}]*width:\s*min\(500px,100%\)/);
});

test("Task Repository branches go through the explicit execution backend", () => {
  const options = script.match(/function taskRepositoryOptions[\s\S]*?\n}\n\nfunction openTaskDialog/)?.[0] || "";
  assert.match(options, /data-repository-branch/);
  assert.doesNotMatch(options, /input type="text"[^>]+基准分支/);
  assert.match(script, /loadTaskRepositoryBranches/);
  assert.match(script, /\/api\/platform\/repositories\/\$\{repository\.id\}\/branches/);
  assert.match(script, /正在加载分支，请稍候/);
  assert.match(script, /base_branch: \$\('\[data-repository-branch\]'/);
  const route = platformRoutes.match(/app\.get\("\/api\/platform\/repositories\/:id\/branches"[\s\S]*?\n}\);/)?.[0] || "";
  assert.match(route, /backend\.repositoryBranches/);
});

test("Task creation keeps one Repository role and leaves edit intent to the user", () => {
  const options = script.match(/function taskRepositoryOptions[\s\S]*?\n}\n\nfunction openTaskDialog/)?.[0] || "";
  assert.match(html, /选择一个已就绪的 Repository/);
  assert.doesNotMatch(options, /data-repository-mode|value="reference"/);
  assert.match(options, /type="checkbox"[^>]+\$\{ready \? "" : "disabled"\}/);
  assert.match(script, /mode: "editable"/);
  assert.match(styles, /\.repo-option\s*\{[^}]*grid-template-columns:\s*24px minmax\(120px,1fr\) 180px/);
});

test("Repository lifecycle workspace closes runtime, Review, PR, and merge behind explicit actions", () => {
  assert.match(script, /data-run-init/);
  assert.match(script, /data-author-agent[\s\S]*Codex[\s\S]*Claude Code[\s\S]*Kimi CLI/);
  const initActions = script.match(/function initTaskActions[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(initActions, /<select/);
  assert.match(initActions, /class="agent-picker"[\s\S]*aria-haspopup="listbox"/);
  assert.match(script, /function wireAgentPicker/);
  assert.match(script, /data-agent-value/);
  assert.match(styles, /\.agent-picker-menu\s*\{[^}]*background:\s*var\(--paper\)/);
  assert.match(script, /body: JSON\.stringify\(\{ agent \}\)/);
  assert.match(script, /data-init-review/);
  assert.match(script, /data-init-pr/);
  assert.match(script, /data-init-merge/);
  assert.match(script, /\/api\/platform\/tasks\/\$\{encodeURIComponent\(task\.key\)\}\/run/);
  assert.match(script, /"pull-request"/);
  assert.match(script, /"merge"/);
  assert.match(script, /forge_kind === "github" \? "PR"/);
  assert.match(script, /forge_kind === "gitlab" \? "MR"/);
  assert.match(script, /pendingActions/);
  assert.match(script, /正在创建 \$\{requestLabel\}/);
  assert.match(script, /要求修改/);
  assert.match(script, /重试完成\$\{task\.task_type === "repository_update" \? "更新" : "初始化"\}/);
  assert.match(script, /openPlatformAgentWorkspace\(workspaceTask\)/);
  assert.match(script, /mobile-agent-action[^>]+data-open-agent/);
  assert.doesNotMatch(script, /index\.html\?task=/);
  assert.match(html, /id="agent-workspace"/);
  assert.match(html, /id="agent-workspace-empty"[\s\S]*Agent 尚未启动/);
  assert.match(html, /id="agent-terminal"/);
  assert.match(html, /id="task-drawer"[\s\S]*id="task-detail"[\s\S]*id="agent-workspace"/);
  assert.match(script, /class="detail-title-row"[\s\S]*id="drawer-close"[\s\S]*class="task-key"[\s\S]*<h1>[\s\S]*taskContextHelp/);
  assert.match(styles, /\.detail-title-row\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/);
  assert.match(styles, /\.drawer-close\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.drawer-close::before\s*\{[^}]*transform:\s*rotate\(45deg\)/);
  assert.match(styles, /\.detail-top h1\s*\{[^}]*line-height:\s*1[^}]*transform:\s*translateY\(-2px\)/);
  assert.match(styles, /\.detail-meta\s*\{[^}]*flex-wrap:\s*wrap[^}]*row-gap:\s*8px/);
  assert.match(styles, /\.detail-meta > \*\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.status-pill\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.task-drawer\s*\{\s*scrollbar-width:\s*none/);
  assert.match(styles, /\.task-drawer::\-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(agent, /connectExecutionPty\(/);
  assert.match(html, /vendor\/addon-canvas\.js/);
  assert.match(agent, /activateCanvasRenderer/);
  assert.match(agent, /attachCustomKeyEventHandler/);
  assert.match(agent, /event\.isComposing && event\.keyCode === 20/);
  assert.match(agent, /Math\.floor\(width \/ cell\.width\)/);
  assert.match(agent, /rescaleOverlappingGlyphs:\s*true/);
  assert.match(agent, /classList\.add\("task-workspace-mode"\)/);
  assert.match(agent, /setConnectionState\(canStartReview \? "等待 Reviewer" : "等待启动", "idle"\)/);
  assert.match(agent, /active\.taskId === executionKey && active\.session === task\.runtime_session/);
  assert.match(styles, /--sidebar-width:\s*210px/);
  assert.match(styles, /--topbar-height:\s*52px/);
  assert.match(styles, /\.topbar\s*\{[^}]*height:\s*var\(--topbar-height\)/);
  assert.match(styles, /\.sidebar\s*\{[^}]*width:\s*var\(--sidebar-width\)/);
  assert.match(styles, /\.main\s*\{[^}]*margin-left:\s*var\(--sidebar-width\)/);
  assert.match(styles, /\.drawer-backdrop\.task-workspace-mode\s*\{[^}]*inset:\s*var\(--topbar-height\) 0 0 var\(--sidebar-width\)/);
  assert.match(styles, /\.drawer-backdrop\.task-workspace-mode \.task-drawer\s*\{[^}]*flex:\s*0 0 clamp\(404px,calc\(42% - 36px\),584px\)[^}]*padding:\s*14px/);
  assert.match(styles, /\.agent-workspace-empty\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center/);
  assert.match(styles, /\.agent-workspace-close,\.mobile-agent-action\s*\{\s*display:\s*none/);
  assert.doesNotMatch(styles, /\.agent-workspace\s*\{[^}]*position:\s*fixed/);
  assert.match(script, /手动模式与诊断命令/);
});

test("Repository lifecycle Task presents the Repository name with contextual help and no role badge", () => {
  assert.match(script, /function taskDisplayTitle/);
  assert.match(script, /isRepositoryLifecycleTask\(task\)/);
  assert.match(script, /class="detail-title-row"/);
  assert.match(script, /class="task-context-help"/);
  assert.match(script, /role="tooltip"/);
  assert.match(script, /display_title: displayTitle/);
  assert.match(agent, /task\.display_title \|\| task\.title/);
  const repository = script.match(/function detailRepository[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(repository, /mode-badge|repo\.mode|editable|reference/);
  assert.match(styles, /\.task-context-help:hover > p[^}]*display:\s*block/);
  assert.match(script, /contextHelp\?\.addEventListener\("mouseleave"/);
  assert.match(script, /contextHelp\.removeAttribute\("open"\)/);
  assert.match(styles, /\.detail-repo\s*\{[^}]*grid-template-columns:\s*minmax\(120px,1fr\) minmax\(160px,1\.2fr\)/);
});

test("Review is an assigned handoff with an optional reviewer Agent and a separate PR action", () => {
  assert.match(html, /id="review-dialog"[\s\S]*name="reviewer_user_id"[\s\S]*推送并分派/);
  assert.match(html, /id="changes-requested-dialog"[\s\S]*name="feedback"[\s\S]*退回修改/);
  assert.match(script, /reviewer_user_id: reviewerUserId/);
  assert.match(script, /taskAssignedToCurrentUser/);
  assert.match(script, /data-review-decision="changes_requested"/);
  assert.match(script, /data-review-decision="approved"/);
  assert.match(script, /\/review\/decision/);
  assert.match(script, /JSON\.stringify\(\{ decision, feedback \}\)/);
  assert.match(script, /openChangesRequestedDialog\(task\)/);
  assert.match(script, /task\.status === "approved" && task\.pr_state === "none"/);
  assert.doesNotMatch(script, /审核通过并创建/);
  assert.match(html, /id="agent-workspace-agent"[\s\S]*Codex[\s\S]*Claude Code[\s\S]*Kimi CLI/);
  assert.match(agent, /canStartReview/);
  assert.match(agent, /startReviewAgent\(emptyTask/);
  assert.match(script, /\/review\/run/);
  assert.match(script, /正在打开 Review 工作区/);
});

test("ordinary Task approval exposes a design baseline instead of PR actions", () => {
  const actions = script.match(/function initTaskActions[\s\S]*?\n}\n\nfunction taskLocalCommands/)?.[0] || "";
  assert.match(actions, /task\.status === "approved" && !isRepositoryLifecycleTask\(task\)/);
  assert.match(actions, /设计已确认，可以开始实现/);
  assert.match(actions, /repository\.design_commit/);
  assert.match(script, /status === "approved" && !isRepositoryLifecycleTask\(task\)[\s\S]*"可开始实现"/);
});

test("a returned Repository Init always exposes explicit resumption and Review submission", () => {
  const actions = script.match(/function initTaskActions[\s\S]*?\n}\n\nfunction taskLocalCommands/)?.[0] || "";
  assert.match(actions, /task\.status === "draft"/);
  assert.match(actions, /data-run-init>继续 Agent/);
  assert.match(actions, /data-init-review>提交 Review/);
  assert.doesNotMatch(actions, /manifest_status === "valid"/);
  assert.match(html, /Runner 执行 ay validate、检查 worktree 与提交并推送工作分支/);
});

test("every Review decision closes the reviewer workspace before the Author continues", () => {
  const submit = script.match(/async function submitReview[\s\S]*?\n}\n\nfunction openRepositoryDialog/)?.[0] || "";
  assert.match(submit, /replacePlatformTask\(updated\)[\s\S]*closeTaskDetail\(\)/);
  assert.doesNotMatch(submit, /openTaskDetail\(key\)/);

  const decision = script.match(/async function decideReview[\s\S]*?\n}\n\nasync function initWorkflowAction/)?.[0] || "";
  assert.match(decision, /Every Review decision ends the current actor's workspace/);
  assert.match(decision, /closeTaskDetail\(\)/);
  assert.doesNotMatch(decision, /openTaskDetail\(task\.key\)/);
  const actions = script.match(/function initTaskActions[\s\S]*?\n}\n\nfunction taskLocalCommands/)?.[0] || "";
  assert.match(actions, /task\.pr_state === "none" && taskBelongsToCurrentUser\(task\)/);
  const createRequestRoute = platformRoutes.match(/app\.post\("\/api\/platform\/tasks\/:key\/pull-request"[\s\S]*?\n}\);/)?.[0] || "";
  assert.match(createRequestRoute, /requireTaskOwner\(req, req\.params\.key\)/);
});

test("opening a Task confirms an open PR or MR once and reflects its remote state", () => {
  assert.match(script, /change-request\/refresh/);
  assert.match(script, /shouldRefreshChangeRequest/);
  assert.match(script, /refreshTaskChangeRequest\(key, task\.pr_state\)/);
  assert.match(script, /openTaskDetail\(selectedKey, \{ refreshChangeRequest: false \}\)/);
  assert.match(script, /正在确认 \$\{requestLabel\} 状态/);
});

test("Task completion is a terminal state after reviewed changes are merged", () => {
  assert.match(script, /completed: "已完成"/);
  assert.match(script, /task\.status === "approved" && task\.pr_state === "none"[\s\S]*data-init-pr/);
  assert.match(script, /task\.status === "approved" && task\.pr_state === "open"[\s\S]*data-init-merge/);
  assert.match(script, /task\.completed_at \? `完成于/);
  assert.match(styles, /\.status-completed/);
  assert.match(platformRoutes, /只有 Task 发起人可以完成 Task/);
});

test("Task detail reads protocol documents transiently from the participant's worktree", () => {
  assert.doesNotMatch(html, /platform-codeview|code-modal|cv-tab-files/);
  assert.doesNotMatch(script, /openTaskCodeContext|data-open-task-changes|data-artifact-path/);
  assert.doesNotMatch(script, /data-load-knowledge/);
  assert.match(script, /task\.runtime_task_id && task\.runtime_has_worktree/);
  assert.match(script, /void loadWorktreeKnowledge\(workspaceTask\)/);
  assert.match(script, /data-knowledge-path/);
  assert.match(script, /openTaskWorktreeBrowser\(task, \{ path: item\.dataset\.knowledgePath \}\)/);
  assert.match(script, /\/api\/platform\/tasks\/\$\{encodeURIComponent\(task\.key\)\}\/knowledge/);
  assert.doesNotMatch(script, /worktree-knowledge-preview|renderKnowledgeMarkdown/);
  assert.match(platformRoutes, /app\.get\("\/api\/platform\/tasks\/:key\/knowledge"/);
  assert.doesNotMatch(platformRoutes, /\/api\/platform\/artifacts|\/api\/platform\/tasks\/:key\/sync/);
});

test("document clicks open an Alignyard full-page worktree file and diff browser", () => {
  assert.match(html, /css\/platform-worktree\.css/);
  assert.match(html, /id="worktree-browser"[\s\S]*id="worktree-tab-files"[\s\S]*id="worktree-tab-changes"[\s\S]*id="worktree-browser-tree"/);
  assert.match(script, /data-open-worktree-changes/);
  assert.match(script, /openTaskWorktreeBrowser\(workspaceTask, \{ tab: "changes" \}\)/);
  assert.match(worktree, /operation, \.\.\.\(path \? \{ path \} : \{\}\)/);
  assert.match(worktree, /worktree-browser-content/);
  assert.match(worktree, /markdownHtml/);
  assert.match(worktree, /renderDiff/);
  assert.match(worktree, /ALL_CHANGES/);
  assert.match(worktree, /inspect\("diff"\)/);
  assert.match(worktree, /全部变更 · 相对/);
  assert.match(worktreeStyles, /grid-template-rows:\s*58px 43px minmax\(0,1fr\)/);
  assert.match(worktreeStyles, /\.worktree-browser-body[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(worktreeStyles, /\.worktree-browser-banner[^}]*position:\s*absolute/s);
  assert.match(worktree, /Platform only authenticates and/);
  assert.match(platformRoutes, /app\.post\("\/api\/platform\/tasks\/:key\/worktree\/inspect"/);
  assert.match(platformRoutes, /cache-control", "no-store"/);
});

test("Runner onboarding monitors versions and offers a local upgrade command", () => {
  const runner = fs.readFileSync(new URL("./js/features/runner-onboarding.js", import.meta.url), "utf8");
  assert.match(runner, /capabilities\?\.version/);
  assert.match(runner, /downloads\/runner\/stable\/\$\{key\}\/manifest\.json/);
  assert.match(runner, /alignyard-runner upgrade/);
  assert.match(html, /工程文档仍保存在 Repository 中/);
});

test("Task actions stay at the bottom of short detail panes", () => {
  assert.match(styles, /#task-detail\s*\{[^}]*display:\s*flex[^}]*min-height:\s*100%[^}]*flex-direction:\s*column/);
  assert.match(styles, /\.detail-actions\s*\{[^}]*margin-top:\s*auto[^}]*padding-top:\s*22px/);
});

test("manual workflow commands keep copy controls readable without the browser focus frame", () => {
  assert.match(styles, /\.detail-command > span\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.detail-command button\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.manual-workflow summary\s*\{[^}]*width:\s*fit-content[^}]*outline:\s*none/);
  assert.match(styles, /\.manual-workflow summary:focus-visible\s*\{[^}]*outline:\s*2px solid color-mix/);
});

test("primary workspace headings share a softer ink color", () => {
  assert.match(styles, /--heading-ink:\s*#453d35/);
  assert.match(styles, /\.brand\s*\{[^}]*color:\s*var\(--heading-ink\)/);
  assert.match(styles, /\.breadcrumbs strong\s*\{[^}]*color:\s*var\(--heading-ink\)/);
  assert.match(styles, /\.detail-top h1\s*\{[^}]*color:\s*var\(--heading-ink\)/);
  assert.match(styles, /\.agent-workspace-context strong\s*\{[^}]*color:\s*var\(--heading-ink\)/);
});

test("Repositories surface exposes guarded deletion through the platform API", () => {
  assert.match(script, /data-delete-repository/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /已被 Task 引用的 Repository 不会被删除/);
  assert.doesNotMatch(script, /window\.confirm/);
  assert.match(html, /id="confirm-dialog"[\s\S]*?<section[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(script, /await confirmDialog\(\{/);
  assert.match(script, /closeConfirmDialog\(false\)/);
});

test("Task items expose protected deletion without opening the detail drawer", () => {
  assert.match(script, /class="task-row"/);
  assert.match(script, /class="task-row-open"[^>]+data-task-key/);
  assert.match(script, /data-delete-task-key/);
  assert.match(script, /class="button danger small task-row-delete"/);
  assert.match(script, /删除 Task？/);
  assert.match(script, /Agent session、worktree 和本地 runtime Task 都会清理/);
  assert.match(script, /\/api\/platform\/tasks\/\$\{encodeURIComponent\(task\.key\)\}/);
  assert.match(script, /method: "DELETE"/);
  assert.doesNotMatch(script, /window\.confirm/);
});

test("long repository and deletion operations use one blocking global loading state", () => {
  assert.match(html, /id="global-loading"[^>]+role="status"/);
  assert.match(script, /正在创建并启动初始化 Task…/);
  assert.match(script, /Runner 正在刷新基准分支、准备 worktree 并启动 Agent，请稍候/);
  assert.match(script, /showGlobalLoading\("正在删除 Task…"/);
  assert.match(script, /showGlobalLoading\("正在删除 Repository…"/);
  assert.match(script, /hideGlobalLoading\(\)/);
  assert.match(styles, /\.global-loading\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*140/);
});

test("Task creation chooses an Agent and starts the Runner worktree in one action", () => {
  const createDialog = html.match(/id="create-task-dialog"[\s\S]*?id="repository-task-launch-dialog"/)?.[0] || "";
  assert.match(createDialog, /name="agent"[\s\S]*data-agent-value="codex"[\s\S]*data-agent-value="claude"[\s\S]*data-agent-value="kimi"/);
  assert.match(createDialog, /id="create-task-submit"[^>]*>创建并启动</);
  assert.match(script, /task = await api\("\/api\/platform\/tasks"/);
  assert.match(script, /task = \(await startTaskRuntime\(task, agent\)\)\.task/);
  assert.match(script, /Runner 正在刷新基准分支、准备 worktree 并启动 Agent/);
  assert.match(script, /已保留，但 Agent 启动失败/);
});

test("polling and read-only Runner errors cannot discard a live Agent terminal", () => {
  assert.match(agent, /active\.taskId === executionKey && active\.session === task\.runtime_session/);
  assert.match(agent, /Never throw away the user's terminal output/);
  assert.match(script, /const loadEpoch = stateMutationEpoch/);
  assert.match(script, /if \(loadEpoch !== stateMutationEpoch\) return/);
  assert.match(platformRunnerBackend, /task\.runtime_status !== "cleaned"/);
  assert.doesNotMatch(platformRunnerBackend, /\["failed", "cleaned"\]/);
});

test("opening a Task automatically opens its active Agent session on every viewport", () => {
  assert.match(script, /function taskHasActiveAgentSession\(task\)/);
  assert.match(script, /task\?\.runner_execution_id[\s\S]*task\.runtime_task_id[\s\S]*task\.runtime_session[\s\S]*task\.runtime_alive/);
  assert.match(script, /if \(taskHasActiveAgentSession\(task\)[\s\S]*openPlatformAgentWorkspace\(workspaceTask\)/);
});

test("empty Tasks and Repositories use a low-contrast patterned board", () => {
  assert.match(styles, /\.task-list\.is-empty\s*\{[^}]*radial-gradient[^}]*22px 22px/);
  assert.match(styles, /\.repository-list\.is-empty\s*\{[^}]*radial-gradient[^}]*22px 22px/);
  assert.match(styles, /inset 0 -28px 70px/);
});

test("Task detail exposes only implemented ay workflow commands", () => {
  assert.doesNotMatch(script, /ay task open/);
  assert.match(script, /"ay init \."/);
  assert.match(script, /ay new doc overview --scope shared/);
  assert.match(script, /--title \\"仓库概览\\"/);
  assert.match(script, /ay validate \./);
  assert.match(script, /ay update --check \./);
  assert.match(script, /ay update \./);
  assert.doesNotMatch(script, /ay sync|--platform/);
});

test("adding a Repository stores credential-free metadata and lets Runner prepare it lazily", () => {
  assert.match(script, /if \(!runnerOnboarding\.enabled\(\)\)[\s\S]*api\("\/api\/repos"/);
  assert.match(script, /api\("\/api\/platform\/repositories"/);
  assert.doesNotMatch(html, /name="token" type="password"/);
  assert.match(html, /Runner 会用你 Mac 上已有的 Git 凭据准备本地镜像/);
  assert.doesNotMatch(script, /created_by:/);
});

test("Google login uses a backend session and authenticated platform members", () => {
  assert.match(html, /id="auth-gate"[\s\S]*id="google-signin-button"/);
  assert.match(script, /\/api\/auth\/config/);
  assert.match(script, /\/api\/auth\/google/);
  assert.match(script, /\/api\/auth\/logout/);
  assert.match(script, /state\.currentUser/);
  assert.doesNotMatch(script, /const CURRENT_USER/);
});

test("cloud composition exposes only Platform and execution-scoped terminal entrypoints", () => {
  assert.match(platformApp, /registerPlatformRoutes\(app, platformRunnerBackend\)/);
  assert.doesNotMatch(platformApp, /registerRoutes\(/);
  assert.match(platformApp, /app\.get\("\/index\.html"[\s\S]*sendStatus\(404\)/);
  assert.match(platformMain, /attachPlatformWs\(server\)/);
  assert.doesNotMatch(platformMain, /http\/ws\.js/);
});

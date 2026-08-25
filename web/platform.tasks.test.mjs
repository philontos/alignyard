import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./platform.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./js/platform.js", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("./js/platform-agent.js", import.meta.url), "utf8");
const codeViewer = fs.readFileSync(new URL("./js/features/codeview.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./css/platform.css", import.meta.url), "utf8");
const codeViewStyles = fs.readFileSync(new URL("./css/platform-codeview.css", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/http/routes.ts", import.meta.url), "utf8");

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

test("Repositories surface shows protocol workflow state and creates a dedicated init Task", () => {
  assert.match(script, /repositoryProtocolState/);
  assert.match(script, /state-\$\{escapeHtml\(protocolState\)\}/);
  assert.match(script, /data-init-repository/);
  assert.match(script, /\/api\/platform\/repositories\/\$\{repositoryId\}\/initialize/);
  assert.match(script, /task\.task_type === "repository_init"/);
  assert.match(script, /已创建，请选择 Agent 启动/);
  const initializeRoute = routes.match(/app\.post\("\/api\/platform\/repositories\/:id\/initialize"[\s\S]*?app\.post\("\/api\/platform\/repositories\/:id\/refresh"/)?.[0] || "";
  assert.match(initializeRoute, /createRepositoryInitializationTask/);
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

test("Task Repository branches reuse Switchyard's live branch catalog", () => {
  const options = script.match(/function taskRepositoryOptions[\s\S]*?\n}\n\nfunction openTaskDialog/)?.[0] || "";
  assert.match(options, /data-repository-branch/);
  assert.doesNotMatch(options, /input type="text"[^>]+基准分支/);
  assert.match(script, /loadTaskRepositoryBranches/);
  assert.match(script, /\/api\/platform\/repositories\/\$\{repository\.id\}\/branches/);
  assert.match(script, /正在加载分支，请稍候/);
  assert.match(script, /base_branch: \$\('\[data-repository-branch\]'/);
  const route = routes.match(/app\.get\("\/api\/platform\/repositories\/:id\/branches"[\s\S]*?\n}\);/)?.[0] || "";
  assert.match(route, /findRepoByGitUrl/);
  assert.match(route, /branchesForOwnedRepo/);
});

test("Task creation keeps one Repository role and leaves edit intent to the user", () => {
  const options = script.match(/function taskRepositoryOptions[\s\S]*?\n}\n\nfunction openTaskDialog/)?.[0] || "";
  assert.match(html, /至少选择一个已就绪的 Repository/);
  assert.doesNotMatch(options, /data-repository-mode|value="reference"/);
  assert.match(options, /type="checkbox"[^>]+\$\{ready \? "" : "disabled"\}/);
  assert.match(script, /mode: "editable"/);
  assert.match(styles, /\.repo-option\s*\{[^}]*grid-template-columns:\s*24px minmax\(120px,1fr\) 180px/);
});

test("Repository Init workspace closes runtime, Review, PR, and merge behind explicit actions", () => {
  assert.match(script, /data-run-init/);
  assert.match(script, /data-author-agent[\s\S]*Codex[\s\S]*Claude Code[\s\S]*Kimi CLI/);
  assert.match(script, /body: JSON\.stringify\(\{ agent \}\)/);
  assert.match(script, /data-init-review/);
  assert.match(script, /data-init-pr/);
  assert.match(script, /data-init-merge/);
  assert.match(script, /\/api\/platform\/tasks\/\$\{encodeURIComponent\(key\)\}\/run/);
  assert.match(script, /"pull-request"/);
  assert.match(script, /"merge"/);
  assert.match(script, /forge_kind === "github" \? "PR"/);
  assert.match(script, /forge_kind === "gitlab" \? "MR"/);
  assert.match(script, /pendingActions/);
  assert.match(script, /正在创建 \$\{requestLabel\}/);
  assert.match(script, /要求修改/);
  assert.match(script, /重试完成初始化/);
  assert.match(script, /openPlatformAgentWorkspace\(task\)/);
  assert.match(script, /mobile-agent-action[^>]+data-open-agent/);
  assert.doesNotMatch(script, /index\.html\?task=/);
  assert.match(html, /id="agent-workspace"/);
  assert.match(html, /id="agent-workspace-empty"[\s\S]*Agent 尚未启动/);
  assert.match(html, /id="agent-terminal"/);
  assert.match(html, /id="task-drawer"[\s\S]*id="task-detail"[\s\S]*id="agent-workspace"/);
  assert.match(agent, /connectPty\(`session=/);
  assert.match(agent, /attachCustomKeyEventHandler/);
  assert.match(agent, /event\.isComposing && event\.keyCode === 20/);
  assert.match(agent, /classList\.add\("task-workspace-mode"\)/);
  assert.match(agent, /setConnectionState\(canStartReview \? "等待 Reviewer" : "等待启动", "idle"\)/);
  assert.match(agent, /active\?\.taskId === task\.runtime_task_id && active\.session === task\.runtime_session/);
  assert.match(styles, /\.drawer-backdrop\.task-workspace-mode\s*\{[^}]*inset:\s*64px 0 0 242px/);
  assert.match(styles, /\.drawer-backdrop\.task-workspace-mode \.task-drawer\s*\{[^}]*flex:/);
  assert.match(styles, /\.agent-workspace-empty\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center/);
  assert.match(styles, /\.agent-workspace-close,\.mobile-agent-action\s*\{\s*display:\s*none/);
  assert.doesNotMatch(styles, /\.agent-workspace\s*\{[^}]*position:\s*fixed/);
  assert.match(script, /手动模式与诊断命令/);
});

test("Review is an assigned handoff with an optional reviewer Agent and a separate PR action", () => {
  assert.match(html, /id="review-dialog"[\s\S]*name="reviewer_user_id"[\s\S]*推送并分派/);
  assert.match(script, /reviewer_user_id: reviewerUserId/);
  assert.match(script, /taskAssignedToCurrentUser/);
  assert.match(script, /data-review-decision="changes_requested"/);
  assert.match(script, /data-review-decision="approved"/);
  assert.match(script, /\/review\/decision/);
  assert.match(script, /task\.status === "approved" && task\.pr_state === "none"/);
  assert.doesNotMatch(script, /审核通过并创建/);
  assert.match(html, /id="agent-workspace-agent"[\s\S]*Codex[\s\S]*Claude Code[\s\S]*Kimi CLI/);
  assert.match(agent, /canStartReview/);
  assert.match(agent, /startReviewAgent\(emptyTask/);
  assert.match(script, /\/review\/run/);
  assert.match(script, /正在打开 Review 工作区/);
});

test("Review handoffs close the current workspace except for approved Repository Init", () => {
  const submit = script.match(/async function submitReview[\s\S]*?\n}\n\nfunction openRepositoryDialog/)?.[0] || "";
  assert.match(submit, /replacePlatformTask\(updated\)[\s\S]*closeTaskDetail\(\)/);
  assert.doesNotMatch(submit, /openTaskDetail\(key\)/);

  const decision = script.match(/async function decideReview[\s\S]*?\n}\n\nasync function initWorkflowAction/)?.[0] || "";
  assert.match(decision, /approved && updated\.task_type === "repository_init"[\s\S]*openTaskDetail\(task\.key\)/);
  assert.match(decision, /else \{[\s\S]*closeTaskDetail\(\)/);
});

test("Task Review reuses the Switchyard file and diff viewer", () => {
  assert.match(html, /href="\/css\/platform-codeview\.css"/);
  assert.match(html, /id="code-modal"[\s\S]*id="cv-tab-files"[\s\S]*id="cv-tab-changes"/);
  assert.match(script, /openTaskCodeContext/);
  assert.match(script, /task\.runtime_task_id/);
  assert.match(script, /tab: "changes"/);
  assert.match(script, /data-open-task-changes/);
  assert.match(script, /data-artifact-path/);
  assert.match(script, /openTaskChanges\(task, button\.dataset\.artifactPath\)/);
  assert.match(codeViewer, /buildFileTree\(changes\.files\.map\(\(file\) => file\.path\)\)/);
  assert.match(codeViewer, /renderChangeTreeNode\(changeTree, list, 0, changeByPath\)/);
  assert.match(codeViewer, /openChangeDirs = parentDirectoryPaths/);
  assert.match(codeViewer, /label\.textContent = treeFile\.name/);
  assert.match(codeViewStyles, /#code-modal\.code-modal-bg[\s\S]*z-index:\s*150/);
  assert.match(styles, /\.artifact-row:not\(:disabled\):hover/);
});

test("document and config previews use a compact soft-wrapped reading mode", () => {
  assert.match(codeViewStyles, /\.cv-content\.cv-readable\s*\{[^}]*overflow-x:\s*hidden/);
  assert.match(codeViewStyles, /\.cv-readable \.cv-source\s*\{[^}]*width:\s*min\(100%, 88ch\)[^}]*white-space:\s*pre-wrap[^}]*word-break:\s*break-word/);
  assert.match(codeViewStyles, /\.cv-readable \.cv-json-leaf\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
  assert.match(codeViewStyles, /\.cv-readable \.cv-diff-line\s*\{[^}]*white-space:\s*pre-wrap/);
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
  assert.match(script, /Agent session、worktree、本地 runtime Task 和工程知识快照都会清理/);
  assert.match(script, /\/api\/platform\/tasks\/\$\{encodeURIComponent\(task\.key\)\}/);
  assert.match(script, /method: "DELETE"/);
  assert.doesNotMatch(script, /window\.confirm/);
});

test("long repository and deletion operations use one blocking global loading state", () => {
  assert.match(html, /id="global-loading"[^>]+role="status"/);
  assert.match(script, /showGlobalLoading\("正在创建初始化 Task…"/);
  assert.match(script, /正在准备初始化流程，请稍候/);
  assert.match(script, /showGlobalLoading\("正在删除 Task…"/);
  assert.match(script, /showGlobalLoading\("正在删除 Repository…"/);
  assert.match(script, /hideGlobalLoading\(\)/);
  assert.match(styles, /\.global-loading\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*140/);
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
  assert.match(script, /ay sync \. --platform/);
});

test("adding a Repository registers locally before sharing credential-free metadata", () => {
  const localCall = script.indexOf('api("/api/repos"');
  const platformCall = script.indexOf('api("/api/platform/repositories"', localCall);
  assert.ok(localCall >= 0 && platformCall > localCall);
  assert.match(html, /name="token" type="password"/);
  assert.match(script, /token: undefined/);
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

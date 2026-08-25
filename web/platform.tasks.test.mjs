import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./platform.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./js/platform.js", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("./js/platform-agent.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./css/platform.css", import.meta.url), "utf8");
const codeViewStyles = fs.readFileSync(new URL("./css/platform-codeview.css", import.meta.url), "utf8");

test("Tasks surface keeps only the three primary filters and one create action", () => {
  const taskView = html.match(/<section class="view active" id="view-tasks"[\s\S]*?<\/section>/)?.[0] || "";
  assert.deepEqual(
    [...taskView.matchAll(/data-task-filter="([^"]+)"/g)].map((match) => match[1]),
    ["all", "mine", "review"],
  );
  assert.match(taskView, /data-create-task>＋ Task<\/button>/);
  assert.doesNotMatch(taskView, /summary-grid|task-search|page-heading/);
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
});

test("Repositories surface shows protocol workflow state and creates a dedicated init Task", () => {
  assert.match(script, /repositoryProtocolState/);
  assert.match(script, /state-\$\{escapeHtml\(protocolState\)\}/);
  assert.match(script, /data-init-repository/);
  assert.match(script, /\/api\/platform\/repositories\/\$\{repositoryId\}\/initialize/);
  assert.match(script, /task\.task_type === "repository_init"/);
  assert.match(script, /初始化 Agent 已启动/);
  assert.doesNotMatch(html, /notice-card|repo-search|repository-card/);
});

test("Repository Init drawer closes runtime, Review, PR, and merge behind explicit actions", () => {
  assert.match(script, /data-run-init/);
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
  assert.match(script, /data-open-agent/);
  assert.match(script, /openPlatformAgentWorkspace\(task\)/);
  assert.doesNotMatch(script, /index\.html\?task=/);
  assert.match(html, /id="agent-workspace"/);
  assert.match(html, /id="agent-terminal"/);
  assert.match(html, /id="task-drawer"[\s\S]*id="task-detail"[\s\S]*id="agent-workspace"/);
  assert.match(agent, /connectPty\(`session=/);
  assert.match(agent, /classList\.add\("agent-mode"\)/);
  assert.match(styles, /\.drawer-backdrop\.agent-mode\s*\{[^}]*inset:\s*64px 0 0 242px/);
  assert.match(styles, /\.drawer-backdrop\.agent-mode \.task-drawer\s*\{[^}]*flex:/);
  assert.doesNotMatch(styles, /\.agent-workspace\s*\{[^}]*position:\s*fixed/);
  assert.match(script, /手动模式与诊断命令/);
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
  assert.match(codeViewStyles, /#code-modal\.code-modal-bg[\s\S]*z-index:\s*150/);
  assert.match(styles, /\.artifact-row:not\(:disabled\):hover/);
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

test("long deletion operations use one blocking global loading state", () => {
  assert.match(html, /id="global-loading"[^>]+role="status"/);
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
  assert.match(script, /token: undefined, created_by: "Phil"/);
});

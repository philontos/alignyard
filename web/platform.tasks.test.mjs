import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./platform.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./js/platform.js", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("./js/platform-agent.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./css/platform.css", import.meta.url), "utf8");

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

test("Repositories surface exposes guarded deletion through the platform API", () => {
  assert.match(script, /data-delete-repository/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /已被 Task 引用的 Repository 不会被删除/);
  assert.doesNotMatch(script, /window\.confirm/);
  assert.match(html, /id="confirm-dialog"[\s\S]*?<section[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(script, /await confirmDialog\(\{/);
  assert.match(script, /closeConfirmDialog\(false\)/);
});

test("Task detail exposes only implemented ay workflow commands", () => {
  assert.doesNotMatch(script, /ay task open/);
  assert.match(script, /"ay init \."/);
  assert.match(script, /ay new doc overview --scope shared/);
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

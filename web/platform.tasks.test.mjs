import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./platform.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./js/platform.js", import.meta.url), "utf8");

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

test("Repositories surface uses one binary protocol dot and routes Init through a draft Task", () => {
  assert.match(script, /class="protocol-indicator \$\{repo\.protocol_initialized \? "initialized" : ""\}"/);
  assert.match(script, /data-init-repository/);
  assert.match(script, /title: `Initialize Alignyard/);
  assert.match(script, /运行 ay init 与 ay validate/);
  assert.doesNotMatch(html, /notice-card|repo-search|repository-card/);
});

test("adding a Repository registers locally before sharing credential-free metadata", () => {
  const localCall = script.indexOf('api("/api/repos"');
  const platformCall = script.indexOf('api("/api/platform/repositories"', localCall);
  assert.ok(localCall >= 0 && platformCall > localCall);
  assert.match(html, /name="token" type="password"/);
  assert.match(script, /token: undefined, created_by: "Phil"/);
});

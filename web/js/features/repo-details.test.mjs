import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../css/app.css", import.meta.url), "utf8");
const repos = readFileSync(new URL("./repos.js", import.meta.url), "utf8");
const hosts = readFileSync(new URL("./hosts.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");

test("clicking local and remote repository rows opens the information sheet", () => {
  assert.match(repos, /class="grp-head repo-head[^\n]*onclick="openRepoDetails\(\$\{r\.id\}\)"/);
  assert.match(hosts, /class="grp-head repo-head"[^\n]*onclick="openRepoDetails\(\$\{Number\(r\.id\)\},\$\{h\.id\}\)"/);
  assert.match(repos, /class="grp-toggle"[^\n]*event\.stopPropagation\(\);toggleRepo/,
    "the old expand/collapse action remains available without hijacking the repo click");
  assert.match(main, /openRepoDetails, openRepoDetailsKey, closeRepoDetails/);
});

test("repository information sheet contains the core read-only fields", () => {
  const modal = html.match(/<div id="repo-info-modal"[\s\S]*?<div id="onboarding-modal"/)?.[0] || "";
  for (const id of ["ri-name", "ri-host", "ri-url", "ri-branch", "ri-status", "ri-created"]) {
    assert.match(modal, new RegExp(`id="${id}"`));
  }
  assert.match(css, /\.repo-info-modal\s*\{/);
  assert.match(main, /\$\("repo-info-modal"\)\.addEventListener\("click"/);
});

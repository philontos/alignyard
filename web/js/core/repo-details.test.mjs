import test from "node:test";
import assert from "node:assert/strict";
import { displayGitUrl, formatRepoDate, repoDetailsData } from "./repo-details.js";

const tr = (key) => ({
  "host.local": "Local",
  "repo.infoStatusReady": "Ready",
  "repo.infoStatusChecking": "Checking access",
  "repo.infoStatusError": "Access failed",
  "repo.infoStatusUnknown": "Unknown",
}[key] || key);

test("repository details expose useful metadata without URL credentials", () => {
  const details = repoDetailsData({
    id: 7,
    name: "switchyard",
    git_url: "https://oauth2:secret@example.com/org/repo.git?token=also-secret",
    default_branch: "main",
    status: "ready",
    created_at: "2026-08-07 02:30:00",
  }, { kind: "local", name: "ignored" }, tr, "en");

  assert.equal(details.id, 7);
  assert.equal(details.host, "Local");
  assert.equal(details.gitUrl, "https://example.com/org/repo.git");
  assert.equal(details.branch, "main");
  assert.equal(details.statusLabel, "Ready");
  assert.ok(details.createdAt);
});

test("SCP-style Git URLs stay readable and missing remote-only fields stay empty", () => {
  assert.equal(displayGitUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  const details = repoDetailsData({ id: 9, name: "remote", default_branch: "dev", status: "cloning" },
    { kind: "ssh", name: "build-box" }, tr, "en");
  assert.equal(details.host, "build-box");
  assert.equal(details.gitUrl, "");
  assert.equal(details.createdAt, "");
  assert.equal(details.statusLabel, "Checking access");
});

test("invalid registration timestamps remain visible instead of becoming Invalid Date", () => {
  assert.equal(formatRepoDate("legacy timestamp", "en"), "legacy timestamp");
});

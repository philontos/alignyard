import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { referencePrompt, resolveReferenceInputs } from "./references.ts";

const opts = { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" };

function seed() {
  const db = new Database(":memory:");
  initSchema(db, opts);
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (1,'local','','local','online')").run();
  db.prepare("INSERT INTO hosts (id,name,target,kind,status) VALUES (2,'remote','dev@remote','ssh','online')").run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (1,1,'API Service','git@example/api','develop','/mirror/api.git','ready')",
  ).run();
  db.prepare(
    "INSERT INTO repos (id,host_id,name,git_url,default_branch,mirror_path,status) VALUES (2,2,'remote','git@example/remote','main','/remote/mirror.git','ready')",
  ).run();
  return db;
}

test("resolveReferenceInputs resolves only owner-local repository coordinates", () => {
  const result = resolveReferenceInputs(seed(), [{ repo_id: 1 }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.references[0].requested_ref, "develop");
  assert.equal(result.references[0].alias, "api-service");
  assert.equal(result.references[0].repo.mirror_path, "/mirror/api.git");
});

test("resolveReferenceInputs normalizes and de-duplicates aliases", () => {
  const result = resolveReferenceInputs(seed(), [
    { repo_id: 1, ref: "feature/contracts", alias: "API docs" },
    { repo_id: 1, ref: "develop", alias: "API docs" },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.references.map((reference) => reference.alias), ["api-docs", "api-docs-2"]);
});

test("resolveReferenceInputs avoids aliases already attached to a running task", () => {
  const result = resolveReferenceInputs(seed(), [
    { repo_id: 1, ref: "develop", alias: "API docs" },
  ], ["api-docs", "api-docs-2"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.references[0].alias, "api-docs-3");
});

test("resolveReferenceInputs rejects remote-owned repositories and unsafe branch refspecs", () => {
  assert.deepEqual(resolveReferenceInputs(seed(), [{ repo_id: 2, ref: "main" }]), {
    ok: false,
    error: "reference repository 2 was not found on this node",
  });
  const unsafe = resolveReferenceInputs(seed(), [{ repo_id: 1, ref: "main:refs/heads/injected" }]);
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.match(unsafe.error, /invalid reference branch/);
});

test("referencePrompt leaves ordinary prompts untouched and describes referenced roots", () => {
  assert.equal(referencePrompt({ name: "primary", path: "/wt/primary" }, [], "work"), "work");
  const prompt = referencePrompt(
    { name: "primary", path: "/wt/primary" },
    [{
      alias: "api",
      repo_name: "backend",
      requested_ref: "develop",
      resolved_commit: "a".repeat(40),
      worktree_path: "/wt/refs/1/api",
    }],
    "compare contracts",
  );
  assert.match(prompt || "", /ref:api \(reference-only\)/);
  assert.match(prompt || "", /aaaaaaaaaaaa/);
  assert.match(prompt || "", /User task:\ncompare contracts/);
});

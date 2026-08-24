import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import type { Runner } from "../fleet/runner.ts";
import { createPlatformRepository } from "./catalog.ts";
import { refreshRepositoryProtocol } from "./protocol.ts";

function setup(manifest: string | null) {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  const hostId = Number(db.prepare(
    "INSERT INTO hosts (name,target,kind) VALUES ('local','','local')",
  ).run().lastInsertRowid);
  db.prepare(
    "INSERT INTO repos (host_id,name,git_url,default_branch,mirror_path,status) VALUES (?,?,?,?,?,'ready')",
  ).run(hostId, "alignyard", "git@example.com:team/alignyard.git", "main", "/mirror.git");
  const repository = createPlatformRepository(db, {
    name: "alignyard",
    git_url: "git@example.com:team/alignyard.git",
    default_branch: "main",
    created_by: "Phil",
  });
  const runner = {
    kind: "local", dataDir: "/data",
    exec: async (_file: string, args: string[]) => args[0] === "show" ? (manifest ?? Promise.reject(new Error("missing"))) : "",
    async mkdirp() {}, async exists() { return false; }, async readText() { return null; }, async rmrf() {},
    async putDir() {}, async putFile() {},
  } as unknown as Runner;
  return { db, repository, runner };
}

test("protocol refresh derives ready and uninitialized states from the default branch baseline", async () => {
  const valid = setup("version: 1\npreset: basic\nscopes:\n  - id: shared\n");
  const ready = await refreshRepositoryProtocol(valid.db, valid.runner, valid.repository.id);
  assert.equal(ready.ok && ready.repository.protocol_initialized, true);
  assert.equal(ready.ok && ready.repository.protocol_state, "ready");

  const missing = setup(null);
  const waiting = await refreshRepositoryProtocol(missing.db, missing.runner, missing.repository.id);
  assert.equal(waiting.ok && waiting.repository.protocol_initialized, false);
  assert.equal(waiting.ok && waiting.repository.protocol_state, "uninitialized");

  const invalid = setup("version: 2\npreset: basic\nscopes:\n  - id: shared\n");
  const broken = await refreshRepositoryProtocol(invalid.db, invalid.runner, invalid.repository.id);
  assert.equal(broken.ok && broken.repository.protocol_state, "invalid");
  assert.match(broken.ok ? broken.repository.protocol_error || "" : "", /version 必须是 1/);
});

test("protocol refresh asks for a local repository before touching Git", async () => {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  db.prepare("INSERT INTO hosts (name,target,kind) VALUES ('local','','local')").run();
  const repository = createPlatformRepository(db, {
    name: "remote-only", git_url: "git@example.com:team/remote.git", created_by: "Phil",
  });
  const runner = { kind: "local", dataDir: "/data" } as Runner;
  const result = await refreshRepositoryProtocol(db, runner, repository.id);
  assert.deepEqual(result, { ok: false, reason: "not_local", message: "先在本机添加这个 Repository" });
});

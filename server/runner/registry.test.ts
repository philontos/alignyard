import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  authenticateRunnerToken,
  claimRunnerPairing,
  createRunnerPairing,
  listUserRunners,
  revokeRunner,
  updateRunnerHello,
} from "./registry.ts";

function memoryDb() {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/old", dataDir: "/new" });
  db.prepare(
    "INSERT INTO platform_users (provider,provider_subject,name) VALUES ('google','subject','Phil')",
  ).run();
  return db;
}

test("a pairing code is single-use and yields an opaque Runner credential", () => {
  const db = memoryDb();
  const pairing = createRunnerPairing(db, 1, new Date("2026-01-01T00:00:00Z"));
  const claimed = claimRunnerPairing(db, pairing.code.toLowerCase(), {
    name: "Phil's Mac",
    os: "darwin",
    arch: "arm64",
  }, new Date("2026-01-01T00:01:00Z"));
  assert.ok(claimed);
  assert.match(claimed.runner.id, /^run_/);
  assert.ok(claimed.token.length >= 32);
  assert.equal(authenticateRunnerToken(db, claimed.token)?.id, claimed.runner.id);
  assert.equal(claimRunnerPairing(db, pairing.code, {
    name: "duplicate", os: "darwin", arch: "arm64",
  }, new Date("2026-01-01T00:02:00Z")), null);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM platform_runners").get()), new RegExp(claimed.token));
});

test("expired pairing codes cannot register a Runner", () => {
  const db = memoryDb();
  const pairing = createRunnerPairing(db, 1, new Date("2026-01-01T00:00:00Z"));
  assert.equal(claimRunnerPairing(db, pairing.code, {
    name: "late", os: "darwin", arch: "arm64",
  }, new Date("2026-01-01T00:11:00Z")), null);
});

test("Runner hello updates capabilities and revocation is owner scoped", () => {
  const db = memoryDb();
  const pairing = createRunnerPairing(db, 1);
  const claimed = claimRunnerPairing(db, pairing.code, {
    name: "Mac", os: "darwin", arch: "arm64",
  });
  assert.ok(claimed);
  const updated = updateRunnerHello(db, claimed.runner.id, 1, {
    git: true,
    tmux: true,
    ssh: true,
    agents: { codex: true, claude: false, kimi: false },
    forge: { gh: true, glab: false },
  }, true);
  assert.equal(updated?.status, "online");
  assert.equal((updated?.capabilities as any).agents.codex, true);
  assert.equal(listUserRunners(db, 1).length, 1);
  assert.equal(revokeRunner(db, claimed.runner.id, 999), false);
  assert.equal(revokeRunner(db, claimed.runner.id, 1), true);
  assert.equal(authenticateRunnerToken(db, claimed.token), null);
});

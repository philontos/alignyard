import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import { createPlatformRepository, createPlatformTask } from "./catalog.ts";
import { PlatformSyncError, syncPlatformTaskKnowledge } from "./sync.ts";
import { createRepositoryDocument, indexRepositoryProtocol, initializeRepositoryProtocol } from "../protocol/repository.ts";

function fixture() {
  const db = new Database(":memory:");
  initSchema(db, { didMigrate: false, legacyDir: "/legacy", dataDir: "/data" });
  const repository = createPlatformRepository(db, {
    name: "app",
    git_url: "git@example.com:team/app.git",
    created_by: "Phil",
  });
  const task = createPlatformTask(db, {
    title: "Knowledge",
    owner: "Phil",
    repositories: [{ repository_id: repository.id, mode: "editable" }],
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-sync-"));
  initializeRepositoryProtocol(root);
  createRepositoryDocument(root, { kind: "doc", slug: "overview", scope: "shared", title: "Overview" });
  const indexed = indexRepositoryProtocol(root);
  return { db, repository, task, root, indexed };
}

test("platform accepts a validated editable Task knowledge snapshot", () => {
  const value = fixture();
  try {
    const result = syncPlatformTaskKnowledge(value.db, value.task.key, {
      repository_id: value.repository.id,
      manifest: value.indexed.manifest,
      base_commit: "a".repeat(40),
      head_commit: "b".repeat(40),
      documents: value.indexed.documents.map((document) => ({ ...document, change_kind: "added" })),
    });
    assert.equal(result.documents, 1);
    assert.equal(result.task.artifacts.length, 1);
    assert.equal(result.task.artifacts[0].kind, "doc");
    assert.equal(result.task.repositories[0].manifest_status, "valid");
    assert.equal(result.task.repositories[0].head_commit, "b".repeat(40));
    const stored = value.db.prepare(
      "SELECT document_id,scope,content,content_hash FROM platform_artifacts",
    ).get() as { document_id: string; scope: string; content: string; content_hash: string };
    assert.equal(stored.document_id, "doc.shared.overview");
    assert.equal(stored.scope, "shared");
    assert.match(stored.content, /# Overview/);
    assert.equal(stored.content_hash.length, 64);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("platform rejects tampered sync content", () => {
  const value = fixture();
  try {
    const documents = value.indexed.documents.map((document) => ({
      ...document,
      content: `${document.content}\ntampered`,
      change_kind: "modified",
    }));
    assert.throws(() => syncPlatformTaskKnowledge(value.db, value.task.key, {
      repository_id: value.repository.id,
      manifest: value.indexed.manifest,
      documents,
    }), (error: unknown) => error instanceof PlatformSyncError && /content_hash 不匹配/.test(error.message));
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

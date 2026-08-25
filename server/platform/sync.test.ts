import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../core/schema.ts";
import {
  createPlatformRepository,
  createRepositoryInitializationTask,
  updatePlatformTaskStatus,
} from "./catalog.ts";
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
  const task = createRepositoryInitializationTask(db, repository.id, "Phil");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-sync-"));
  initializeRepositoryProtocol(root);
  const overview = createRepositoryDocument(root, { kind: "doc", slug: "overview", scope: "shared", title: "仓库概览" });
  fs.appendFileSync(path.join(root, overview.path), "\n这里记录仓库当前已经验证的工程事实。\n", "utf8");
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
    assert.equal(updatePlatformTaskStatus(value.db, value.task.key, "review")?.status, "review");
    const stored = value.db.prepare(
      "SELECT document_id,scope,content,content_hash FROM platform_artifacts",
    ).get() as { document_id: string; scope: string; content: string; content_hash: string };
    assert.equal(stored.document_id, "doc.shared.overview");
    assert.equal(stored.scope, "shared");
    assert.match(stored.content, /# 概述/);
    assert.equal(stored.content_hash.length, 64);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("repository init rejects English-only knowledge before Review", () => {
  const value = fixture();
  try {
    const target = path.join(value.root, ".alignyard/docs/shared/overview.md");
    fs.writeFileSync(target, `---\nid: doc.shared.overview\ntitle: Repository Overview\nkind: doc\nscope: shared\nowners: []\nrelations: []\n---\n\n# Overview\n\nEnglish-only repository facts.\n`, "utf8");
    const indexed = indexRepositoryProtocol(value.root);
    assert.throws(() => syncPlatformTaskKnowledge(value.db, value.task.key, {
      repository_id: value.repository.id,
      manifest: indexed.manifest,
      documents: indexed.documents.map((document) => ({ ...document, change_kind: "added" })),
    }), (error: unknown) => error instanceof PlatformSyncError && /必须使用中文/.test(error.message));
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

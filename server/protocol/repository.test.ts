import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRepositoryDocument,
  indexRepositoryProtocol,
  initializeRepositoryProtocol,
  parseRepositoryManifest,
  validateRepositoryProtocol,
} from "./repository.ts";

function temporaryRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-protocol-"));
}

test("repository manifest accepts the minimal v1 protocol", () => {
  const parsed = parseRepositoryManifest("version: 1\npreset: basic\nscopes:\n  - id: shared\n");
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.manifest?.scopes[0].id, "shared");
});

test("ay init scaffold is idempotent and validates", () => {
  const root = temporaryRepository();
  try {
    const first = initializeRepositoryProtocol(root);
    const second = initializeRepositoryProtocol(root);
    assert.ok(first.created.includes(".alignyard/repository.yaml"));
    assert.equal(second.created.length, 0);
    assert.equal(validateRepositoryProtocol(root).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay new renders repository templates into stable scoped documents", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    const document = createRepositoryDocument(root, {
      kind: "adr",
      slug: "0001-storage-boundary",
      scope: "shared",
      title: "Keep Storage Local",
    });
    assert.equal(document.id, "adr.shared.0001-storage-boundary");
    assert.equal(document.path, ".alignyard/adrs/shared/0001-storage-boundary.md");
    assert.equal(validateRepositoryProtocol(root).ok, true);
    const indexed = indexRepositoryProtocol(root);
    assert.equal(indexed.documents[0].title, "Keep Storage Local");
    assert.equal(indexed.documents[0].content_hash.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repository manifest requires the shared routing scope", () => {
  const parsed = parseRepositoryManifest("version: 1\npreset: basic\nscopes:\n  - id: web\n");
  assert.match(parsed.errors.join("\n"), /必须声明 shared scope/);
});

test("validator checks document scope, kind, sections, IDs, and relations", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    const target = path.join(root, ".alignyard/specs/shared/broken.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `---\nid: spec.shared.broken\ntitle: Broken\nkind: doc\nscope: missing\nrelations: [doc.missing]\n---\n\n# Context\n`, "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /kind 必须是 spec/);
    assert.match(result.errors.join("\n"), /scope「missing」未在 repository.yaml 中声明/);
    assert.match(result.errors.join("\n"), /id 中的 scope 必须是 missing/);
    assert.match(result.errors.join("\n"), /缺少「Goals」章节/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

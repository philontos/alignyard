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

test("repository manifest v2 requires fixed knowledge entrypoints", () => {
  const missing = parseRepositoryManifest("version: 2\npreset: basic\nscopes:\n  - id: shared\n");
  assert.match(missing.errors.join("\n"), /必须声明 entrypoints/);
  const parsed = parseRepositoryManifest(
    "version: 2\npreset: basic\nentrypoints:\n  overview: doc.shared.overview\n  constitution: doc.shared.constitution\nscopes:\n  - id: shared\n",
  );
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.manifest?.entrypoints?.constitution, "doc.shared.constitution");
});

test("protocol v2 resolves the fixed overview entrypoint by both ID and path", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    const overview = createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    const target = path.join(root, overview.path);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(
      "id: doc.shared.overview",
      "id: doc.shared.repository-map",
    ), "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /缺少 \.alignyard\/docs\/shared\/overview\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay init scaffold is idempotent and requires a shared overview baseline", () => {
  const root = temporaryRepository();
  try {
    const first = initializeRepositoryProtocol(root);
    const second = initializeRepositoryProtocol(root);
    assert.ok(first.created.includes(".alignyard/repository.yaml"));
    assert.equal(second.created.length, 0);
    assert.equal(validateRepositoryProtocol(root).ok, false);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    assert.equal(validateRepositoryProtocol(root).ok, true);
    assert.match(fs.readFileSync(path.join(root, ".alignyard/README.md"), "utf8"), /核心工程意图与架构约束真源/);
    assert.match(fs.readFileSync(path.join(root, ".alignyard/templates/spec.md"), "utf8"), /# 验收标准/);
    assert.ok(fs.existsSync(path.join(root, ".alignyard/templates/plan.md")));
    assert.ok(fs.existsSync(path.join(root, ".alignyard/docs/shared/constitution.md")));
    const skill = fs.readFileSync(path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md"), "utf8");
    assert.match(skill, /minimal, sufficient baseline/);
    assert.match(skill, /architecture and dependency boundaries/);
    assert.match(skill, /intent-coverage review/);
    assert.match(skill, /not truth, sufficiency, or concision/);
    assert.match(skill, /Simplified Chinese/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay new renders repository templates into stable scoped documents", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    const document = createRepositoryDocument(root, {
      kind: "adr",
      slug: "0001-storage-boundary",
      scope: "shared",
      title: "存储保留在本机",
    });
    assert.equal(document.id, "adr.shared.0001-storage-boundary");
    assert.equal(document.path, ".alignyard/adrs/shared/0001-storage-boundary.md");
    assert.equal(validateRepositoryProtocol(root).ok, true);
    const indexed = indexRepositoryProtocol(root);
    const indexedAdr = indexed.documents.find((item) => item.id === document.id);
    assert.equal(indexedAdr?.title, "存储保留在本机");
    assert.equal(indexedAdr?.content_hash.length, 64);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol v2 creates Plans with traceability metadata and validates governing knowledge", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    const spec = createRepositoryDocument(root, {
      kind: "spec", slug: "login", scope: "shared", title: "登录需求",
    });
    const plan = createRepositoryDocument(root, {
      kind: "plan", slug: "login", scope: "shared", title: "登录技术方案",
    });
    const target = path.join(root, plan.path);
    const content = fs.readFileSync(target, "utf8")
      .replace("sources: []", "sources:\n  - source://requirement/login")
      .replace("governing: []", `governing:\n  - doc.shared.constitution\n  - ${spec.id}`);
    fs.writeFileSync(target, content, "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, true, result.errors.join("\n"));
    const indexedPlan = indexRepositoryProtocol(root).documents.find((item) => item.id === plan.id);
    assert.deepEqual(indexedPlan?.sources, ["source://requirement/login"]);
    assert.deepEqual(indexedPlan?.governing, ["doc.shared.constitution", spec.id]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol v2 rejects Plans without a constitution governing reference", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    createRepositoryDocument(root, {
      kind: "plan", slug: "login", scope: "shared", title: "登录技术方案",
    });
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /必须包含 doc\.shared\.constitution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol v1 rejects Plans without invalidating legacy documents", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    fs.writeFileSync(
      path.join(root, ".alignyard/repository.yaml"),
      "version: 1\npreset: basic\nscopes:\n  - id: shared\n",
      "utf8",
    );
    assert.throws(() => createRepositoryDocument(root, {
      kind: "plan", slug: "unsupported", scope: "shared", title: "旧协议方案",
    }), /protocol v1 不支持 plan/);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    assert.equal(validateRepositoryProtocol(root).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validator keeps repositories with legacy English section headings valid", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    fs.writeFileSync(path.join(root, ".alignyard/templates/doc.md"), `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Overview\n`, "utf8");
    fs.writeFileSync(path.join(root, ".alignyard/templates/spec.md"), `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Context\n\n# Goals\n\n# Non-goals\n\n# Design\n\n# Acceptance Criteria\n`, "utf8");
    fs.writeFileSync(path.join(root, ".alignyard/templates/adr.md"), `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Context\n\n# Decision\n\n# Consequences\n`, "utf8");
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "Repository Overview",
    });

    assert.equal(validateRepositoryProtocol(root).ok, true);
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
    assert.match(result.errors.join("\n"), /缺少「目标」章节/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

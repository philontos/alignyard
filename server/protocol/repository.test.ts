import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALIGNYARD_FRAMEWORK_VERSION,
  ALIGNYARD_PROTOCOL_VERSION,
  createRepositoryDocument,
  indexRepositoryProtocol,
  initializeRepositoryProtocol,
  parseRepositoryManifest,
  updateRepositoryFramework,
  validateRepositoryProtocol,
} from "./repository.ts";

function temporaryRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-protocol-"));
}

function completePlanTaskLedger(root: string, planPath: string, governingId: string): string {
  const target = path.join(root, planPath);
  const content = fs.readFileSync(target, "utf8")
    .replace("governing: []", `governing:\n  - doc.shared.constitution\n  - ${governingId}`)
    .replace(/# 实施任务[\s\S]*?# 验证方案/, `# 实施任务

## P0 契约与基础结构

- [ ] P0.1 定义协议结构
  - 依赖：无
  - 产出：Plan 任务协议
  - 完成标准：结构约束明确
  - 验证：\`npm test\`
  - 验证结果：待执行

## P1 核心实现

- [ ] P1.1 实现校验器
  - 依赖：P0.1
  - 产出：任务账本校验器
  - 完成标准：正向与负向用例通过
  - 验证：\`node --test\`
  - 验证结果：待执行

# 验证方案`);
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function createValidPlanRepository(root: string) {
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
  const target = completePlanTaskLedger(root, plan.path, spec.id);
  return { plan, spec, target };
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
    assert.equal(
      parseRepositoryManifest(fs.readFileSync(path.join(root, ".alignyard/repository.yaml"), "utf8")).manifest?.framework_version,
      ALIGNYARD_FRAMEWORK_VERSION,
    );
    assert.equal(
      parseRepositoryManifest(fs.readFileSync(path.join(root, ".alignyard/repository.yaml"), "utf8")).manifest?.version,
      ALIGNYARD_PROTOCOL_VERSION,
    );
    assert.equal(second.created.length, 0);
    assert.equal(validateRepositoryProtocol(root).ok, false);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    assert.equal(validateRepositoryProtocol(root).ok, true);
    assert.match(fs.readFileSync(path.join(root, ".alignyard/README.md"), "utf8"), /核心工程意图与架构约束真源/);
    assert.match(fs.readFileSync(path.join(root, ".alignyard/templates/spec.md"), "utf8"), /# 验收标准/);
    assert.ok(fs.existsSync(path.join(root, ".alignyard/templates/plan.md")));
    assert.ok(fs.existsSync(path.join(root, ".alignyard/plans/shared")));
    assert.ok(fs.existsSync(path.join(root, ".alignyard/docs/shared/constitution.md")));
    const skill = fs.readFileSync(path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md"), "utf8");
    assert.match(skill, /minimal, sufficient baseline/);
    assert.match(skill, /architecture and dependency boundaries/);
    assert.match(skill, /intent-coverage review/);
    assert.match(skill, /Semantic alignment across boundaries/);
    assert.match(skill, /equivalent, different, or unknown/);
    assert.match(skill, /must not copy or redefine repository knowledge/);
    assert.match(skill, /not truth, sufficiency, or concision/);
    assert.match(skill, /Simplified Chinese/);
    assert.match(fs.readFileSync(path.join(root, ".alignyard/templates/spec.md"), "utf8"), /受影响的业务概念与系统边界/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay update replaces managed framework files while preserving repository knowledge and scopes", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    const overviewPath = path.join(root, ".alignyard/docs/shared/overview.md");
    const overview = fs.readFileSync(overviewPath, "utf8").replace("# 概述", "# 概述\n\n保留的仓库知识。");
    fs.writeFileSync(overviewPath, overview, "utf8");
    fs.writeFileSync(
      path.join(root, ".alignyard/repository.yaml"),
      "version: 1\npreset: basic\nscopes:\n  - id: shared\n    title: Shared\n  - id: web\n    title: Web\n",
      "utf8",
    );
    fs.writeFileSync(path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md"), "old skill\n", "utf8");

    const preview = updateRepositoryFramework(root, { check: true });
    assert.equal(preview.check, true);
    assert.equal(preview.from.protocol_version, 1);
    assert.equal(preview.from.framework_version, 0);
    assert.ok(preview.changes.some((change) => change.path === ".alignyard/repository.yaml"));
    assert.equal(fs.readFileSync(path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md"), "utf8"), "old skill\n");

    const updated = updateRepositoryFramework(root);
    assert.equal(updated.to.framework_version, ALIGNYARD_FRAMEWORK_VERSION);
    const manifest = parseRepositoryManifest(fs.readFileSync(path.join(root, ".alignyard/repository.yaml"), "utf8")).manifest;
    assert.equal(manifest?.version, ALIGNYARD_PROTOCOL_VERSION);
    assert.equal(manifest?.framework_version, ALIGNYARD_FRAMEWORK_VERSION);
    assert.deepEqual(manifest?.scopes.map((scope) => scope.id), ["shared", "web"]);
    const updatedSkill = fs.readFileSync(path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md"), "utf8");
    assert.match(updatedSkill, /Framework update/);
    assert.match(updatedSkill, /Semantic alignment across boundaries/);
    assert.equal(fs.readFileSync(overviewPath, "utf8"), overview);
    assert.equal(updateRepositoryFramework(root, { check: true }).changes.length, 0);
    assert.equal(validateRepositoryProtocol(root).ok, true);
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

test("protocol v3 creates task-ledger Plans with traceability metadata and validates governing knowledge", () => {
  const root = temporaryRepository();
  try {
    const { plan, spec, target } = createValidPlanRepository(root);
    const content = fs.readFileSync(target, "utf8")
      .replace("sources: []", "sources:\n  - source://requirement/login");
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

test("protocol v3 rejects Plans without a constitution governing reference", () => {
  const root = temporaryRepository();
  try {
    const { target } = createValidPlanRepository(root);
    const content = fs.readFileSync(target, "utf8")
      .replace(/governing:\n  - doc\.shared\.constitution\n  - spec\.shared\.login/, "governing:\n  - spec.shared.login");
    fs.writeFileSync(target, content, "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /必须包含 doc\.shared\.constitution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol v3 rejects Plans without governing knowledge beyond the constitution", () => {
  const root = temporaryRepository();
  try {
    const { target } = createValidPlanRepository(root);
    const content = fs.readFileSync(target, "utf8")
      .replace(/governing:\n  - doc\.shared\.constitution\n  - spec\.shared\.login/, "governing:\n  - doc.shared.constitution");
    fs.writeFileSync(target, content, "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /除 Constitution 外还必须关联/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protocol v3 validates Plan phases, checkboxes, task IDs, fields, and completion evidence", () => {
  const cases: Array<{ name: string; mutate: (content: string) => string; error: RegExp }> = [
    {
      name: "missing phase",
      mutate: (content) => content.replace("## P0 契约与基础结构", "## 契约与基础结构"),
      error: /Phase 必须使用/,
    },
    {
      name: "missing checkbox",
      mutate: (content) => content.replace("- [ ] P0.1 定义协议结构", "- P0.1 定义协议结构"),
      error: /必须使用.*checkbox 格式/,
    },
    {
      name: "duplicate task ID",
      mutate: (content) => content.replace("P1.1 实现校验器", "P0.1 实现校验器"),
      error: /任务编号「P0\.1」重复/,
    },
    {
      name: "task outside phase",
      mutate: (content) => content.replace("P1.1 实现校验器", "P2.1 实现校验器"),
      error: /任务 P2\.1 必须属于 Phase P1/,
    },
    {
      name: "missing required field",
      mutate: (content) => content.replace("  - 产出：Plan 任务协议\n", ""),
      error: /任务 P0\.1 缺少非空「产出」字段/,
    },
    {
      name: "placeholder remains",
      mutate: (content) => content.replace("定义协议结构", "TODO：定义协议结构"),
      error: /标题不能保留 TODO/,
    },
    {
      name: "completed without validation result",
      mutate: (content) => content
        .replace("- [ ] P0.1", "- [x] P0.1")
        .replace("  - 验证结果：待执行", "  - 验证结果：未执行"),
      error: /已完成任务 P0\.1 必须记录实际验证结果/,
    },
  ];

  for (const variant of cases) {
    const root = temporaryRepository();
    try {
      const { target } = createValidPlanRepository(root);
      fs.writeFileSync(target, variant.mutate(fs.readFileSync(target, "utf8")), "utf8");
      const result = validateRepositoryProtocol(root);
      assert.equal(result.ok, false, variant.name);
      assert.match(result.errors.join("\n"), variant.error, variant.name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("protocol v2 keeps legacy Plans valid until an explicit framework update", () => {
  const root = temporaryRepository();
  try {
    initializeRepositoryProtocol(root);
    fs.writeFileSync(path.join(root, ".alignyard/repository.yaml"), `version: 2
framework_version: 3
preset: basic
entrypoints:
  overview: doc.shared.overview
  constitution: doc.shared.constitution
scopes:
  - id: shared
`, "utf8");
    fs.writeFileSync(path.join(root, ".alignyard/templates/plan.md"), `---
id: {{id}}
title: {{title}}
kind: {{kind}}
scope: {{scope}}
relations: []
sources: []
governing: []
---

# 背景与目标
# 依据与约束
# 实现设计
# 修改范围
# 保持不变
# 实施步骤
# 验证方案
# 文档更新
# 未决问题
`, "utf8");
    createRepositoryDocument(root, {
      kind: "doc", slug: "overview", scope: "shared", title: "仓库概览",
    });
    const plan = createRepositoryDocument(root, {
      kind: "plan", slug: "legacy", scope: "shared", title: "旧版技术方案",
    });
    const target = path.join(root, plan.path);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8")
      .replace("governing: []", "governing:\n  - doc.shared.constitution"), "utf8");
    const result = validateRepositoryProtocol(root);
    assert.equal(result.ok, true, result.errors.join("\n"));
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

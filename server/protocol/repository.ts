import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const ALIGNYARD_DIR = ".alignyard";
export const ALIGNYARD_MANIFEST = `${ALIGNYARD_DIR}/repository.yaml`;
export const ALIGNYARD_PROTOCOL_VERSION = 2 as const;
export const ALIGNYARD_PROTOCOL_VERSIONS = [1, 2] as const;
export const ALIGNYARD_FRAMEWORK_VERSION = 1 as const;
export type AlignyardProtocolVersion = typeof ALIGNYARD_PROTOCOL_VERSIONS[number];

export const KNOWLEDGE_KINDS = ["doc", "spec", "adr", "plan"] as const;
const V1_KNOWLEDGE_KINDS = ["doc", "spec", "adr"] as const;
const COMMON_BOOTSTRAP_FILES = [
  ".alignyard/repository.yaml",
  ".alignyard/README.md",
  ".alignyard/templates/doc.md",
  ".alignyard/templates/spec.md",
  ".alignyard/templates/adr.md",
  ".alignyard/skills/alignyard-knowledge/SKILL.md",
  ".alignyard/docs/shared/overview.md",
] as const;
export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number];

export function requiredBootstrapFiles(version: AlignyardProtocolVersion): readonly string[] {
  return version === 2
    ? [...COMMON_BOOTSTRAP_FILES, ".alignyard/templates/plan.md", ".alignyard/docs/shared/constitution.md"]
    : COMMON_BOOTSTRAP_FILES;
}

export interface ProtocolScope {
  id: string;
  title?: string;
  source?: string;
}

export interface RepositoryProtocolManifest {
  version: AlignyardProtocolVersion;
  framework_version: number;
  preset: "basic";
  scopes: ProtocolScope[];
  entrypoints?: {
    overview: string;
    constitution: string;
  };
}

export interface ProtocolDocument {
  id: string;
  kind: KnowledgeKind;
  scope: string;
  title: string;
  path: string;
  owners: string[];
  relations: string[];
  sources: string[];
  governing: string[];
}

export interface IndexedProtocolDocument extends ProtocolDocument {
  content: string;
  content_hash: string;
}

export interface ProtocolValidation {
  ok: boolean;
  initialized: boolean;
  manifest?: RepositoryProtocolManifest;
  documents: ProtocolDocument[];
  errors: string[];
}

export interface CreateProtocolDocumentInput {
  kind: KnowledgeKind;
  slug: string;
  scope: string;
  title?: string;
}

export interface FrameworkUpdateChange {
  path: string;
  action: "create" | "replace" | "merge";
}

export interface FrameworkUpdateResult {
  repository: string;
  check: boolean;
  from: { protocol_version: AlignyardProtocolVersion; framework_version: number };
  to: { protocol_version: typeof ALIGNYARD_PROTOCOL_VERSION; framework_version: typeof ALIGNYARD_FRAMEWORK_VERSION };
  changes: FrameworkUpdateChange[];
}

const KIND_DIRS: Record<KnowledgeKind, string> = {
  doc: "docs",
  spec: "specs",
  adr: "adrs",
  plan: "plans",
};

interface RequiredSection {
  label: string;
  headings: string[];
}

// New repositories use Chinese headings. English aliases remain valid so the
// protocol upgrade does not invalidate repositories initialized before the
// language policy was introduced.
const REQUIRED_SECTIONS: Record<KnowledgeKind, RequiredSection[]> = {
  doc: [{ label: "概述", headings: ["概述", "Overview"] }],
  spec: [
    { label: "背景", headings: ["背景", "Context"] },
    { label: "目标", headings: ["目标", "Goals"] },
    { label: "非目标", headings: ["非目标", "Non-goals", "Non Goals"] },
    { label: "设计", headings: ["设计", "Design"] },
    { label: "验收标准", headings: ["验收标准", "Acceptance Criteria"] },
  ],
  adr: [
    { label: "背景", headings: ["背景", "Context"] },
    { label: "决策", headings: ["决策", "Decision"] },
    { label: "影响", headings: ["影响", "Consequences"] },
  ],
  plan: [
    { label: "背景与目标", headings: ["背景与目标", "Context and Goals"] },
    { label: "依据与约束", headings: ["依据与约束", "Sources and Constraints"] },
    { label: "实现设计", headings: ["实现设计", "Implementation Design"] },
    { label: "修改范围", headings: ["修改范围", "Change Scope"] },
    { label: "保持不变", headings: ["保持不变", "Preserve"] },
    { label: "实施步骤", headings: ["实施步骤", "Implementation Steps"] },
    { label: "验证方案", headings: ["验证方案", "Validation"] },
    { label: "文档更新", headings: ["文档更新", "Documentation Updates"] },
    { label: "未决问题", headings: ["未决问题", "Open Questions"] },
  ],
};

const SCOPE_ID = /^[a-z][a-z0-9-]*$/;
const DOCUMENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_ID = /^(doc|spec|adr|plan)\.([a-z][a-z0-9-]*)\.([a-z0-9]+(?:[.-][a-z0-9]+)*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeRepositoryPath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  return !value.split(/[\\/]+/).some((part) => part === ".." || part === "");
}

function displayPath(target: string): string {
  return target.split(path.sep).join("/");
}

export function knowledgeDirectory(kind: KnowledgeKind): string {
  return KIND_DIRS[kind];
}

export function knowledgeKindsForVersion(version: AlignyardProtocolVersion): readonly KnowledgeKind[] {
  return version === 2 ? KNOWLEDGE_KINDS : V1_KNOWLEDGE_KINDS;
}

export function parseRepositoryManifest(text: string): { manifest?: RepositoryProtocolManifest; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error: any) {
    return { errors: [`repository.yaml: ${String(error?.message || error)}`] };
  }
  if (!isRecord(raw)) return { errors: ["repository.yaml: 根节点必须是对象"] };
  const version = raw.version as AlignyardProtocolVersion;
  if (!ALIGNYARD_PROTOCOL_VERSIONS.includes(version)) errors.push("repository.yaml: version 必须是 1 或 2");
  let frameworkVersion = 0;
  if (raw.framework_version != null) {
    if (!Number.isInteger(raw.framework_version) || Number(raw.framework_version) < 0) {
      errors.push("repository.yaml: framework_version 必须是非负整数");
    } else {
      frameworkVersion = Number(raw.framework_version);
      if (frameworkVersion > ALIGNYARD_FRAMEWORK_VERSION) {
        errors.push(
          `repository.yaml: framework_version ${frameworkVersion} 高于当前 ay 支持的 ${ALIGNYARD_FRAMEWORK_VERSION}；请先升级 Runner`,
        );
      }
    }
  }
  if (raw.preset !== "basic") errors.push("repository.yaml: preset 必须是 basic");
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
    errors.push("repository.yaml: 至少声明一个 scope");
  }

  const scopes: ProtocolScope[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of (Array.isArray(raw.scopes) ? raw.scopes : []).entries()) {
    if (!isRecord(candidate)) {
      errors.push(`repository.yaml: scopes[${index}] 必须是对象`);
      continue;
    }
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!SCOPE_ID.test(id)) errors.push(`repository.yaml: scope id「${id || index}」无效`);
    if (seen.has(id)) errors.push(`repository.yaml: scope id「${id}」重复`);
    seen.add(id);
    const title = typeof candidate.title === "string" && candidate.title.trim() ? candidate.title.trim() : undefined;
    const source = typeof candidate.source === "string" && candidate.source.trim() ? candidate.source.trim() : undefined;
    if (source && !safeRepositoryPath(source)) errors.push(`repository.yaml: scope「${id}」的 source 路径不安全`);
    scopes.push({ id, title, source });
  }
  if (!seen.has("shared")) errors.push("repository.yaml: 必须声明 shared scope");

  let entrypoints: RepositoryProtocolManifest["entrypoints"];
  if (version === 2) {
    if (!isRecord(raw.entrypoints)) {
      errors.push("repository.yaml: version 2 必须声明 entrypoints");
    } else {
      const overview = typeof raw.entrypoints.overview === "string" ? raw.entrypoints.overview.trim() : "";
      const constitution = typeof raw.entrypoints.constitution === "string" ? raw.entrypoints.constitution.trim() : "";
      if (overview !== "doc.shared.overview") {
        errors.push("repository.yaml: entrypoints.overview 必须是 doc.shared.overview");
      }
      if (constitution !== "doc.shared.constitution") {
        errors.push("repository.yaml: entrypoints.constitution 必须是 doc.shared.constitution");
      }
      if (overview && constitution) entrypoints = { overview, constitution };
    }
  }

  return errors.length
    ? { errors }
    : {
        manifest: {
          version,
          framework_version: frameworkVersion,
          preset: "basic",
          scopes,
          ...(entrypoints ? { entrypoints } : {}),
        },
        errors,
      };
}

function markdownFiles(root: string, errors: string[]): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`${displayPath(path.relative(root, target))}: 不允许符号链接`);
      } else if (entry.isDirectory()) {
        walk(target);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(target);
      }
    }
  };
  walk(root);
  return out.sort();
}

function splitFrontmatter(text: string, filePath: string, errors: string[]) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    errors.push(`${filePath}: 缺少 YAML frontmatter`);
    return undefined;
  }
  try {
    const metadata = YAML.parse(match[1]);
    if (!isRecord(metadata)) throw new Error("frontmatter 必须是对象");
    return { metadata, body: match[2] };
  } catch (error: any) {
    errors.push(`${filePath}: ${String(error?.message || error)}`);
    return undefined;
  }
}

function stringField(metadata: Record<string, unknown>, field: string, filePath: string, errors: string[]) {
  const value = typeof metadata[field] === "string" ? metadata[field].trim() : "";
  if (!value) errors.push(`${filePath}: ${field} 不能为空`);
  return value;
}

function stringListField(
  metadata: Record<string, unknown>,
  field: string,
  filePath: string,
  errors: string[],
): string[] {
  if (metadata[field] == null) return [];
  if (!Array.isArray(metadata[field]) || !(metadata[field] as unknown[]).every((item) => typeof item === "string" && item.trim())) {
    errors.push(`${filePath}: ${field} 必须是非空字符串数组`);
    return [];
  }
  const values = (metadata[field] as string[]).map((item) => item.trim());
  if (new Set(values).size !== values.length) errors.push(`${filePath}: ${field} 不能包含重复项`);
  return values;
}

function validateDocument(
  root: string,
  file: string,
  kind: KnowledgeKind,
  scopes: Set<string>,
  errors: string[],
): ProtocolDocument | undefined {
  const filePath = displayPath(path.relative(root, file));
  const parsed = splitFrontmatter(fs.readFileSync(file, "utf8"), filePath, errors);
  if (!parsed) return undefined;
  const id = stringField(parsed.metadata, "id", filePath, errors);
  const title = stringField(parsed.metadata, "title", filePath, errors);
  const declaredKind = stringField(parsed.metadata, "kind", filePath, errors);
  const scope = stringField(parsed.metadata, "scope", filePath, errors);
  const owners = stringListField(parsed.metadata, "owners", filePath, errors);
  const relations = stringListField(parsed.metadata, "relations", filePath, errors);
  const sources = stringListField(parsed.metadata, "sources", filePath, errors);
  const governing = stringListField(parsed.metadata, "governing", filePath, errors);

  if (declaredKind && declaredKind !== kind) errors.push(`${filePath}: kind 必须是 ${kind}`);
  if (scope && !scopes.has(scope)) errors.push(`${filePath}: scope「${scope}」未在 repository.yaml 中声明`);

  const parts = filePath.split("/");
  const expectedDirectory = KIND_DIRS[kind];
  if (parts.length < 4 || parts[0] !== ALIGNYARD_DIR || parts[1] !== expectedDirectory || parts[2] !== scope) {
    errors.push(`${filePath}: 文件必须位于 ${ALIGNYARD_DIR}/${expectedDirectory}/${scope}/`);
  }

  const idMatch = id.match(DOCUMENT_ID);
  if (!idMatch) {
    if (id) errors.push(`${filePath}: id「${id}」格式无效`);
  } else {
    if (idMatch[1] !== kind) errors.push(`${filePath}: id 必须以 ${kind}. 开头`);
    if (idMatch[2] !== scope) errors.push(`${filePath}: id 中的 scope 必须是 ${scope}`);
  }

  for (const section of REQUIRED_SECTIONS[kind]) {
    const present = section.headings.some((heading) => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^#{1,2}\\s+${escaped}\\s*$`, "mi").test(parsed.body);
    });
    if (!present) {
      errors.push(`${filePath}: 缺少「${section.label}」章节`);
    }
  }
  return id && title && scope && declaredKind === kind
    ? { id, kind, scope, title, path: filePath, owners, relations, sources, governing }
    : undefined;
}

function validateTemplate(root: string, kind: KnowledgeKind, errors: string[]) {
  const relative = `${ALIGNYARD_DIR}/templates/${kind}.md`;
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) {
    errors.push(`缺少 ${relative}`);
    return;
  }
  if (fs.lstatSync(target).isSymbolicLink()) {
    errors.push(`${relative}: 不允许符号链接`);
    return;
  }
  const text = fs.readFileSync(target, "utf8");
  for (const token of ["{{id}}", "{{title}}", "{{kind}}", "{{scope}}"] as const) {
    if (!text.includes(token)) errors.push(`${relative}: 缺少模板变量 ${token}`);
  }
  for (const section of REQUIRED_SECTIONS[kind]) {
    const present = section.headings.some((heading) => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^#{1,2}\\s+${escaped}\\s*$`, "mi").test(text);
    });
    if (!present) {
      errors.push(`${relative}: 缺少「${section.label}」章节`);
    }
  }
}

export function validateRepositoryProtocol(repositoryRoot: string): ProtocolValidation {
  const root = path.resolve(repositoryRoot);
  const manifestPath = path.join(root, ALIGNYARD_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, initialized: false, documents: [], errors: [`缺少 ${ALIGNYARD_MANIFEST}`] };
  }
  const errors: string[] = [];
  if (fs.lstatSync(manifestPath).isSymbolicLink()) {
    return { ok: false, initialized: true, documents: [], errors: [`${ALIGNYARD_MANIFEST}: 不允许符号链接`] };
  }
  const parsed = parseRepositoryManifest(fs.readFileSync(manifestPath, "utf8"));
  errors.push(...parsed.errors);
  if (!parsed.manifest) return { ok: false, initialized: true, documents: [], errors };
  const protocolVersion = parsed.manifest.version;

  const scopes = new Set(parsed.manifest.scopes.map((scope) => scope.id));
  for (const scope of parsed.manifest.scopes) {
    if (scope.source && !fs.existsSync(path.join(root, scope.source))) {
      errors.push(`repository.yaml: scope「${scope.id}」的 source 不存在：${scope.source}`);
    }
  }

  const supportedKinds = knowledgeKindsForVersion(parsed.manifest.version);
  for (const kind of supportedKinds) validateTemplate(root, kind, errors);
  const skillPath = path.join(root, ALIGNYARD_DIR, "skills/alignyard-knowledge/SKILL.md");
  if (!fs.existsSync(skillPath)) errors.push(`缺少 ${ALIGNYARD_DIR}/skills/alignyard-knowledge/SKILL.md`);
  else if (fs.lstatSync(skillPath).isSymbolicLink()) errors.push(`${ALIGNYARD_DIR}/skills/alignyard-knowledge/SKILL.md: 不允许符号链接`);

  const documents: ProtocolDocument[] = [];
  for (const kind of KNOWLEDGE_KINDS) {
    const kindRoot = path.join(root, ALIGNYARD_DIR, KIND_DIRS[kind]);
    if (!supportedKinds.includes(kind)) {
      const unsupported = markdownFiles(kindRoot, errors);
      for (const file of unsupported) {
        errors.push(`${displayPath(path.relative(root, file))}: protocol v1 不支持 plan；请升级 repository.yaml`);
      }
      continue;
    }
    for (const file of markdownFiles(kindRoot, errors)) {
      const document = validateDocument(root, file, kind, scopes, errors);
      if (document) documents.push(document);
    }
  }

  const ids = new Set<string>();
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  for (const document of documents) {
    if (ids.has(document.id)) errors.push(`${document.path}: id「${document.id}」重复`);
    ids.add(document.id);
  }
  for (const document of documents) {
    for (const relation of document.relations) {
      if (!ids.has(relation)) errors.push(`${document.path}: relation「${relation}」不存在`);
    }
    for (const governing of document.governing) {
      const target = documentsById.get(governing);
      if (!target) {
        errors.push(`${document.path}: governing「${governing}」不存在`);
      } else if (governing === document.id) {
        errors.push(`${document.path}: governing 不能指向自身「${governing}」`);
      } else if (target.kind === "plan") {
        errors.push(`${document.path}: governing 不能指向技术方案「${governing}」`);
      }
    }
    if (document.kind === "plan") {
      if (!document.governing.includes("doc.shared.constitution")) {
        errors.push(`${document.path}: Plan 的 governing 必须包含 doc.shared.constitution`);
      }
    }
  }

  if (!documents.some((document) => document.kind === "doc"
    && document.path === `${ALIGNYARD_DIR}/docs/shared/overview.md`
    && (protocolVersion === 1 || document.id === "doc.shared.overview")
  )) {
    errors.push(`缺少 ${ALIGNYARD_DIR}/docs/shared/overview.md；初始化需要一份 shared overview`);
  }
  if (protocolVersion === 2 && !documents.some((document) =>
    document.kind === "doc"
      && document.id === "doc.shared.constitution"
      && document.path === `${ALIGNYARD_DIR}/docs/shared/constitution.md`
  )) {
    errors.push(`缺少 ${ALIGNYARD_DIR}/docs/shared/constitution.md；protocol v2 需要固定 constitution 入口`);
  }

  return { ok: errors.length === 0, initialized: true, manifest: parsed.manifest, documents, errors };
}

const DEFAULT_TEMPLATES: Record<KnowledgeKind, string> = {
  doc: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nrelations: []\nsources: []\ngoverning: []\n---\n\n# 概述\n`,
  spec: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nrelations: []\nsources: []\ngoverning: []\n---\n\n# 背景\n\n# 目标\n\n# 非目标\n\n# 设计\n\n# 验收标准\n`,
  adr: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nrelations: []\nsources: []\ngoverning: []\n---\n\n# 背景\n\n# 决策\n\n# 影响\n`,
  plan: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nrelations: []\nsources: []\ngoverning: []\n---\n\n# 背景与目标\n\n# 依据与约束\n\n# 实现设计\n\n# 修改范围\n\n# 保持不变\n\n# 实施步骤\n\n# 验证方案\n\n# 文档更新\n\n# 未决问题\n`,
};

const DEFAULT_README = `# Alignyard 工程意图

这个目录是 Repository 中随代码版本管理的核心工程意图与架构约束真源。它只记录未来 AI 不知道时可能造成整体设计漂移的信息；具体函数、局部算法和普通字段传递仍以代码、类型和测试为准。

\`repository.yaml\` 声明协议、知识框架版本、固定入口与逻辑 scopes；Docs 记录当前有效的稳定架构事实，Specs 描述一次变化的意图与边界，ADRs 保存长期取舍，Plans 提供可选的可执行技术方案。文档作者和审核轨迹优先使用 Git commit 与 PR/MR/Alignyard Review，不额外维护一套作者字段。

使用 \`ay new\` 创建文档，在 Review 前运行 \`ay validate\` 并提交全部改动。\`ay update --check\` 可预览框架升级，\`ay update\` 只更新 Alignyard 管理的 Skill、模板和协议结构，不覆盖 Repository 的知识正文。工程文档始终保存在 Repository 和 worktree 中；Platform 不保存副本。
`;

const DEFAULT_CONSTITUTION = `---
id: doc.shared.constitution
title: "工程约束"
kind: doc
scope: shared
relations: []
sources: []
governing: []
---

# 概述

这份文档是 Repository 的固定工程约束入口。初始化时应根据仓库证据补充产品意图、架构边界、需要人工确认的关键不确定性，以及已有机器检查；只记录缺失后可能导致整体设计漂移的信息，具体实现细节留在代码、类型与测试中。缺少依据时直接向用户确认，不自行推断。
`;

export const DEFAULT_KNOWLEDGE_SKILL = `---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's \`.alignyard/repository.yaml\` as the routing contract and \`ay\` as the structural authority. Treat \`.alignyard/\` as the source of truth for core engineering intent and architectural constraints, not as a mirror of the codebase. Keep only decision-relevant, evidence-based, reviewable knowledge.

## Choose the workflow

- **Repository bootstrap:** use when \`.alignyard\` was just initialized or the user asks to establish the initial knowledge framework.
- **Framework update:** use after \`ay update\` replaces Alignyard-managed framework files and asks for a semantic review of existing knowledge.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Repository bootstrap

### 1. Survey repository evidence

1. Inventory tracked source, root README files, package or workspace manifests, build/test/release commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Build an evidence map of the repository's system boundaries, main data flows, stable CLI/API/configuration surfaces, development and operating workflows, and repository-specific conventions. Distinguish verified facts from questions.
3. Define \`shared\` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set \`source\` only when one directory clearly owns that scope.

### 2. Plan a minimal, sufficient baseline

1. Always create the shared repository overview. Use it as a concise map and navigation entry, not as a catch-all document. For protocol v2, also complete the generated Constitution from verified repository constraints and user-confirmed intent; never leave it as a generic placeholder.
2. Cover only durable information that can change an Agent's design direction: product intent, architecture and dependency boundaries, stable public contracts, data/security/permission boundaries, explicit invariants, and important technical choices. Keep implementation details in code, types, tests, or local comments when they are directly recoverable there.
3. Use this test before creating or expanding a document: if a future Agent did not know this fact, could it produce a locally correct implementation that violates the intended system design? If not, omit it. Give a topic its own Doc only when it has enough verified substance and evolves independently.
4. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, an explicit durable decision belongs in ADRs, and a concrete optional implementation design belongs in a Plan. Do not infer an ADR merely from code shape. Bootstrap Specs and Plans are optional; empty or speculative Specs, ADRs, and Plans are prohibited.

### 3. Create and verify documents

1. Use \`ay new\` for every new document, then fill its body from repository evidence. Preserve original documents unless the Task explicitly includes migration or removal.
2. Keep documents focused and add meaningful \`relations\` when the overview or one topic depends on another document.
3. Run an intent-coverage review before validation: ensure core intent, architecture boundaries, stable contracts, invariants, and durable choices are covered, then remove details duplicated from code or tests.
4. Run \`ay validate\` and resolve every structural error. Passing validation proves protocol structure, not truth, sufficiency, or concision.
5. Run \`ay validate\`. Report evidence inspected, scopes and documents created, topics intentionally omitted with reasons, unresolved questions, and validation results.

## Framework update

1. Run \`ay update --check\` before applying an available update, then run \`ay update\`. Treat \`.alignyard/README.md\`, the default templates, and this Skill as Alignyard-managed framework files; keep repository-specific instructions in the Constitution or ordinary knowledge documents.
2. Preserve every existing Doc, Spec, ADR, Plan, stable document ID, scope, relation, source, and governing reference unless repository evidence or an explicit user decision requires a semantic change. The update command migrates structure; it does not rewrite knowledge content.
3. Read the updated Constitution and Overview, then review existing knowledge against the current framework. Remove code-recoverable detail and stale process narration; retain verified intent, boundaries, invariants, stable contracts, and durable decisions.
4. Ask the user before changing consequential intent or architecture. Run \`ay validate\`, commit the complete \`.alignyard/\` diff, and wait for human Review.

## Task work

1. Read the manifest entrypoints first, then route through the relevant scope Docs, active Specs, related ADRs, and existing Plans. Treat the accepted Spec as authoritative over external source links.
2. Decide which existing or new documents the change actually needs. A material new capability or boundary change normally needs a concise Spec; a small correction, documentation-only Task, or change already covered by an accepted Spec may only update existing Docs. Do not create a primary document merely to satisfy a workflow shape.
3. Ask the user directly when missing facts could change product intent, public interfaces, architecture boundaries, compatibility, or change scope. Do not invent a decision. Incorporate the confirmed answer into the final Spec, ADR, Plan, or Doc.
4. Create an ADR only for a durable decision with meaningful alternatives or consequences. Create a Plan only when a concrete implementation design materially reduces ambiguity; Plans are optional.
5. A Plan must govern itself with the Constitution and cite only the Docs, Specs, and ADRs that actually constrain the implementation. A Spec is typical for new behavior or boundary changes, but is not mandatory when existing knowledge already states the intent. State what may change and what must remain unchanged, and include implementation and validation steps. External sources are traceability references, not governing truth.
6. Draft target-state Docs at their normal paths on the Task branch. The branch is the proposal; do not create a temporary Docs copy. Reconcile Docs with the actual implementation before publishing them to the default branch.
7. Unless the Task explicitly requests implementation, stop after producing the reviewable knowledge package. Preserve stable document IDs and use \`relations\` only for meaningful dependencies.
8. Run \`ay validate\` after knowledge changes. Before requesting Review, commit all changes and make sure \`git status --short\` is empty; the Runner will repeat these checks and push the branch when the user submits Review.

## Document semantics

- **Docs:** current accepted system truth. Prefer concise overviews and operational facts that remain useful after the Task closes.
- **Specs:** the contract for an intended change: context, goals, non-goals, design, and acceptance criteria.
- **ADRs:** a durable decision and its consequences. Record why, not a chronological meeting transcript.
- **Plans:** an optional, executable technical design for one intended change. It bridges accepted knowledge to implementation without becoming current system truth.
- **Constitution:** the reserved \`doc.shared.constitution\` entrypoint. It records repository-wide intent, boundaries, confirmation rules, and enforceable constraints.

Keep every document concise and single-purpose. Record the intent, boundary, rationale, or invariant that must survive implementation; omit function-level mechanics, ordinary field plumbing, meeting transcripts, and implementation logs. Git commits, blame, PR/MR review, and Alignyard Review provide authorship and approval traceability; do not add document owners merely to duplicate that history.

## Safety and quality

- Write Docs, Specs, ADRs, and Plans in Simplified Chinese, including titles, headings, and prose. Keep code identifiers, commands, paths, API names, and established product names unchanged when translation would reduce precision. This Skill itself may remain in English.
- Do not invent behavior, ownership, commands, or decisions. Ask the user in the current Agent conversation when a consequential fact or decision is uncertain.
- Do not read or reproduce secret values. Refer to environment-variable names only when relevant.
- Do not edit source paths outside the Task's scope merely to make documentation appear complete.
- Treat \`ay validate\` as authoritative for structure; use repository evidence and user decisions for substance.
`;

function repositoryTitle(root: string): string {
  return path.basename(root).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Repository";
}

export function initializeRepositoryProtocol(repositoryRoot: string): { created: string[]; existing: string[] } {
  const root = path.resolve(repositoryRoot);
  const protocolRoot = path.join(root, ALIGNYARD_DIR);
  const title = repositoryTitle(root);
  const manifestPath = path.join(protocolRoot, "repository.yaml");
  let targetVersion: AlignyardProtocolVersion = ALIGNYARD_PROTOCOL_VERSION;
  if (fs.existsSync(manifestPath)) {
    const parsed = parseRepositoryManifest(fs.readFileSync(manifestPath, "utf8"));
    if (parsed.manifest) targetVersion = parsed.manifest.version;
  }
  const defaultFiles: Record<string, string> = {
    "repository.yaml": `version: 2\nframework_version: ${ALIGNYARD_FRAMEWORK_VERSION}\npreset: basic\n\nentrypoints:\n  overview: doc.shared.overview\n  constitution: doc.shared.constitution\n\nscopes:\n  - id: shared\n    title: ${JSON.stringify(title)}\n`,
    "README.md": DEFAULT_README,
    "templates/doc.md": DEFAULT_TEMPLATES.doc,
    "templates/spec.md": DEFAULT_TEMPLATES.spec,
    "templates/adr.md": DEFAULT_TEMPLATES.adr,
    "skills/alignyard-knowledge/SKILL.md": DEFAULT_KNOWLEDGE_SKILL,
  };
  if (targetVersion === 2) {
    defaultFiles["templates/plan.md"] = DEFAULT_TEMPLATES.plan;
    defaultFiles["docs/shared/constitution.md"] = DEFAULT_CONSTITUTION;
  }
  const created: string[] = [];
  const existing: string[] = [];
  for (const [relative, contents] of Object.entries(defaultFiles)) {
    const target = path.join(protocolRoot, relative);
    const relativePath = `${ALIGNYARD_DIR}/${relative}`;
    if (fs.existsSync(target)) {
      existing.push(relativePath);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
    created.push(relativePath);
  }
  const directories = targetVersion === 2
    ? Object.values(KIND_DIRS)
    : V1_KNOWLEDGE_KINDS.map((kind) => KIND_DIRS[kind]);
  for (const directory of directories) {
    fs.mkdirSync(path.join(protocolRoot, directory, "shared"), { recursive: true });
  }
  return { created, existing };
}

function frameworkFiles(): Record<string, string> {
  return {
    [`${ALIGNYARD_DIR}/README.md`]: DEFAULT_README,
    [`${ALIGNYARD_DIR}/templates/doc.md`]: DEFAULT_TEMPLATES.doc,
    [`${ALIGNYARD_DIR}/templates/spec.md`]: DEFAULT_TEMPLATES.spec,
    [`${ALIGNYARD_DIR}/templates/adr.md`]: DEFAULT_TEMPLATES.adr,
    [`${ALIGNYARD_DIR}/templates/plan.md`]: DEFAULT_TEMPLATES.plan,
    [`${ALIGNYARD_DIR}/skills/alignyard-knowledge/SKILL.md`]: DEFAULT_KNOWLEDGE_SKILL,
  };
}

function upgradedManifest(raw: Record<string, unknown>): string {
  const { version: _version, framework_version: _framework, preset, entrypoints, scopes, ...rest } = raw;
  const existingEntrypoints = isRecord(entrypoints) ? entrypoints : {};
  return YAML.stringify({
    version: ALIGNYARD_PROTOCOL_VERSION,
    framework_version: ALIGNYARD_FRAMEWORK_VERSION,
    preset: preset || "basic",
    entrypoints: {
      ...existingEntrypoints,
      overview: "doc.shared.overview",
      constitution: "doc.shared.constitution",
    },
    scopes,
    ...rest,
  }, { lineWidth: 0 });
}

function writeManagedFile(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`${relative}: 框架文件不允许是符号链接`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

/** Update only Alignyard-managed framework files. Repository knowledge bodies
 * remain untouched and are reviewed semantically by the Agent in the Task. */
export function updateRepositoryFramework(
  repositoryRoot: string,
  options: { check?: boolean } = {},
): FrameworkUpdateResult {
  const root = path.resolve(repositoryRoot);
  const manifestPath = path.join(root, ALIGNYARD_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 ${ALIGNYARD_MANIFEST}；请先运行 ay init`);
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error(`${ALIGNYARD_MANIFEST}: 不允许符号链接`);
  const source = fs.readFileSync(manifestPath, "utf8");
  const parsed = parseRepositoryManifest(source);
  if (!parsed.manifest) throw new Error(parsed.errors.join("\n"));
  const raw = YAML.parse(source);
  if (!isRecord(raw)) throw new Error("repository.yaml: 根节点必须是对象");
  const manifestContents = upgradedManifest(raw);
  const changes: FrameworkUpdateChange[] = [];
  if (source !== manifestContents) changes.push({ path: ALIGNYARD_MANIFEST, action: "merge" });

  for (const [relative, contents] of Object.entries(frameworkFiles())) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) changes.push({ path: relative, action: "create" });
    else if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${relative}: 框架文件不允许是符号链接`);
    else if (fs.readFileSync(target, "utf8") !== contents) changes.push({ path: relative, action: "replace" });
  }
  const constitutionPath = `${ALIGNYARD_DIR}/docs/shared/constitution.md`;
  const constitutionTarget = path.join(root, constitutionPath);
  if (!fs.existsSync(constitutionTarget)) changes.push({ path: constitutionPath, action: "create" });
  else if (fs.lstatSync(constitutionTarget).isSymbolicLink()) {
    throw new Error(`${constitutionPath}: 框架固定入口不允许是符号链接`);
  }

  if (!options.check) {
    for (const [relative, contents] of Object.entries(frameworkFiles())) {
      writeManagedFile(root, relative, contents);
    }
    if (!fs.existsSync(constitutionTarget)) writeManagedFile(root, constitutionPath, DEFAULT_CONSTITUTION);
    for (const directory of Object.values(KIND_DIRS)) {
      for (const scope of parsed.manifest.scopes) {
        fs.mkdirSync(path.join(root, ALIGNYARD_DIR, directory, scope.id), { recursive: true });
      }
    }
    writeManagedFile(root, ALIGNYARD_MANIFEST, manifestContents);
  }

  return {
    repository: root,
    check: options.check === true,
    from: {
      protocol_version: parsed.manifest.version,
      framework_version: parsed.manifest.framework_version,
    },
    to: {
      protocol_version: ALIGNYARD_PROTOCOL_VERSION,
      framework_version: ALIGNYARD_FRAMEWORK_VERSION,
    },
    changes,
  };
}

function defaultTitle(slug: string): string {
  return slug.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

export function createRepositoryDocument(
  repositoryRoot: string,
  input: CreateProtocolDocumentInput,
): ProtocolDocument {
  const root = path.resolve(repositoryRoot);
  if (!KNOWLEDGE_KINDS.includes(input.kind)) throw new Error(`kind 必须是 ${KNOWLEDGE_KINDS.join("、")}`);
  if (!DOCUMENT_SLUG.test(input.slug)) throw new Error("slug 只能包含小写字母、数字和单个连字符");

  const manifestPath = path.join(root, ALIGNYARD_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 ${ALIGNYARD_MANIFEST}；请先运行 ay init`);
  const parsed = parseRepositoryManifest(fs.readFileSync(manifestPath, "utf8"));
  if (!parsed.manifest) throw new Error(parsed.errors.join("\n"));
  if (parsed.manifest.version === 1 && input.kind === "plan") {
    throw new Error("protocol v1 不支持 plan；请先升级 repository.yaml");
  }
  if (!parsed.manifest.scopes.some((scope) => scope.id === input.scope)) {
    throw new Error(`scope「${input.scope}」未在 repository.yaml 中声明`);
  }

  const directory = KIND_DIRS[input.kind];
  const relative = `${ALIGNYARD_DIR}/${directory}/${input.scope}/${input.slug}.md`;
  const target = path.join(root, relative);
  if (fs.existsSync(target)) throw new Error(`${relative} 已存在`);
  const templatePath = path.join(root, ALIGNYARD_DIR, "templates", `${input.kind}.md`);
  if (!fs.existsSync(templatePath)) throw new Error(`缺少 ${ALIGNYARD_DIR}/templates/${input.kind}.md`);

  const id = `${input.kind}.${input.scope}.${input.slug}`;
  const title = input.title?.trim() || defaultTitle(input.slug);
  const replacements: Record<string, string> = {
    "{{id}}": id,
    "{{title}}": JSON.stringify(title),
    "{{kind}}": input.kind,
    "{{scope}}": input.scope,
  };
  let content = fs.readFileSync(templatePath, "utf8");
  for (const [token, value] of Object.entries(replacements)) content = content.replaceAll(token, value);
  const unresolved = content.match(/{{[a-z_]+}}/g);
  if (unresolved) throw new Error(`${ALIGNYARD_DIR}/templates/${input.kind}.md 包含未知模板变量 ${unresolved[0]}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return {
    id,
    kind: input.kind,
    scope: input.scope,
    title,
    path: relative,
    owners: [],
    relations: [],
    sources: [],
    governing: [],
  };
}

export function indexRepositoryProtocol(repositoryRoot: string): {
  manifest: RepositoryProtocolManifest;
  documents: IndexedProtocolDocument[];
} {
  const root = path.resolve(repositoryRoot);
  const result = validateRepositoryProtocol(root);
  if (!result.ok || !result.manifest) throw new Error(result.errors.join("\n"));
  const documents = result.documents.map((document) => {
    const content = fs.readFileSync(path.join(root, document.path), "utf8");
    return {
      ...document,
      content,
      content_hash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  });
  return { manifest: result.manifest, documents };
}

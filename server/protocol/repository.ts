import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const ALIGNYARD_DIR = ".alignyard";
export const ALIGNYARD_MANIFEST = `${ALIGNYARD_DIR}/repository.yaml`;
export const ALIGNYARD_PROTOCOL_VERSION = 1 as const;

export const KNOWLEDGE_KINDS = ["doc", "spec", "adr"] as const;
export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number];

export interface ProtocolScope {
  id: string;
  title?: string;
  source?: string;
}

export interface RepositoryProtocolManifest {
  version: typeof ALIGNYARD_PROTOCOL_VERSION;
  preset: "basic";
  scopes: ProtocolScope[];
}

export interface ProtocolDocument {
  id: string;
  kind: KnowledgeKind;
  scope: string;
  title: string;
  path: string;
  owners: string[];
  relations: string[];
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

const KIND_DIRS: Record<KnowledgeKind, string> = {
  doc: "docs",
  spec: "specs",
  adr: "adrs",
};

const REQUIRED_SECTIONS: Record<KnowledgeKind, string[]> = {
  doc: ["Overview"],
  spec: ["Context", "Goals", "Non-goals", "Design", "Acceptance Criteria"],
  adr: ["Context", "Decision", "Consequences"],
};

const SCOPE_ID = /^[a-z][a-z0-9-]*$/;
const DOCUMENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_ID = /^(doc|spec|adr)\.([a-z][a-z0-9-]*)\.([a-z0-9]+(?:[.-][a-z0-9]+)*)$/;

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

export function parseRepositoryManifest(text: string): { manifest?: RepositoryProtocolManifest; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error: any) {
    return { errors: [`repository.yaml: ${String(error?.message || error)}`] };
  }
  if (!isRecord(raw)) return { errors: ["repository.yaml: 根节点必须是对象"] };
  if (raw.version !== ALIGNYARD_PROTOCOL_VERSION) errors.push("repository.yaml: version 必须是 1");
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

  return errors.length
    ? { errors }
    : { manifest: { version: ALIGNYARD_PROTOCOL_VERSION, preset: "basic", scopes }, errors };
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

  for (const heading of REQUIRED_SECTIONS[kind]) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^#{1,2}\\s+${escaped}\\s*$`, "mi").test(parsed.body)) {
      errors.push(`${filePath}: 缺少「${heading}」章节`);
    }
  }
  return id && title && scope && declaredKind === kind
    ? { id, kind, scope, title, path: filePath, owners, relations }
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
  for (const heading of REQUIRED_SECTIONS[kind]) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^#{1,2}\\s+${escaped}\\s*$`, "mi").test(text)) {
      errors.push(`${relative}: 缺少「${heading}」章节`);
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

  const scopes = new Set(parsed.manifest.scopes.map((scope) => scope.id));
  for (const scope of parsed.manifest.scopes) {
    if (scope.source && !fs.existsSync(path.join(root, scope.source))) {
      errors.push(`repository.yaml: scope「${scope.id}」的 source 不存在：${scope.source}`);
    }
  }

  for (const kind of KNOWLEDGE_KINDS) validateTemplate(root, kind, errors);
  const skillPath = path.join(root, ALIGNYARD_DIR, "skills/alignyard-knowledge/SKILL.md");
  if (!fs.existsSync(skillPath)) errors.push(`缺少 ${ALIGNYARD_DIR}/skills/alignyard-knowledge/SKILL.md`);
  else if (fs.lstatSync(skillPath).isSymbolicLink()) errors.push(`${ALIGNYARD_DIR}/skills/alignyard-knowledge/SKILL.md: 不允许符号链接`);

  const documents: ProtocolDocument[] = [];
  for (const kind of KNOWLEDGE_KINDS) {
    const kindRoot = path.join(root, ALIGNYARD_DIR, KIND_DIRS[kind]);
    for (const file of markdownFiles(kindRoot, errors)) {
      const document = validateDocument(root, file, kind, scopes, errors);
      if (document) documents.push(document);
    }
  }

  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) errors.push(`${document.path}: id「${document.id}」重复`);
    ids.add(document.id);
  }
  for (const document of documents) {
    for (const relation of document.relations) {
      if (!ids.has(relation)) errors.push(`${document.path}: relation「${relation}」不存在`);
    }
  }

  return { ok: errors.length === 0, initialized: true, manifest: parsed.manifest, documents, errors };
}

const DEFAULT_TEMPLATES: Record<KnowledgeKind, string> = {
  doc: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Overview\n`,
  spec: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Context\n\n# Goals\n\n# Non-goals\n\n# Design\n\n# Acceptance Criteria\n`,
  adr: `---\nid: {{id}}\ntitle: {{title}}\nkind: {{kind}}\nscope: {{scope}}\nowners: []\nrelations: []\n---\n\n# Context\n\n# Decision\n\n# Consequences\n`,
};

export const DEFAULT_KNOWLEDGE_SKILL = `---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's \`.alignyard/repository.yaml\` as the routing contract and \`ay\` as the structural authority. Keep the knowledge set small, evidence-based, and reviewable.

## Choose the workflow

- **Repository bootstrap:** use when \`.alignyard\` was just initialized or the user asks to establish the initial knowledge framework.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Repository bootstrap

1. Inventory tracked source, root README files, package or workspace manifests, build commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Define \`shared\` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set \`source\` only when one directory clearly owns that scope.
3. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, and an explicit durable decision belongs in ADRs. Do not infer an ADR merely from code shape.
4. Create the smallest useful baseline: one shared repository overview and one overview for each meaningful scope. Add development or architecture Docs only when the repository provides evidence. A bootstrap Spec is optional; empty or speculative ADRs are prohibited.
5. Use \`ay new\` for every new document, then fill its body. Preserve original documents unless the Task explicitly includes migration or removal.
6. Run \`ay validate\`, resolve every structural error, then run \`ay sync\`. Report created scopes and documents plus any unresolved questions.

## Task work

1. Read the manifest, then the relevant scope Docs, active Specs, and related ADRs before proposing changes.
2. Use a Spec for a material intended change once goals and boundaries are clear. Keep transient conversation and implementation logs out of long-lived knowledge.
3. Update Docs when accepted current behavior changes. Create an ADR only for a durable decision with meaningful alternatives or consequences.
4. Preserve stable document IDs. Use \`relations\` for meaningful dependencies; do not create decorative links.
5. Run \`ay validate\` after knowledge changes and \`ay sync\` before handing the Task back or requesting review.

## Document semantics

- **Docs:** current accepted system truth. Prefer concise overviews and operational facts that remain useful after the Task closes.
- **Specs:** the contract for an intended change: context, goals, non-goals, design, and acceptance criteria.
- **ADRs:** a durable decision and its consequences. Record why, not a chronological meeting transcript.

## Safety and quality

- Do not invent behavior, ownership, commands, or decisions. Mark uncertain facts for confirmation.
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
  const defaultFiles: Record<string, string> = {
    "repository.yaml": `version: 1\npreset: basic\n\nscopes:\n  - id: shared\n    title: ${JSON.stringify(title)}\n`,
    "README.md": `# Alignyard Knowledge\n\nThis directory is the repository's versioned engineering-knowledge workspace. \`repository.yaml\` declares logical scopes; Docs describe current truth, Specs define intended changes, and ADRs preserve durable decisions.\n\nUse \`ay new\` to create documents, \`ay validate\` before review, and \`ay sync\` to publish the current Task snapshot to Alignyard.\n`,
    "templates/doc.md": DEFAULT_TEMPLATES.doc,
    "templates/spec.md": DEFAULT_TEMPLATES.spec,
    "templates/adr.md": DEFAULT_TEMPLATES.adr,
    "skills/alignyard-knowledge/SKILL.md": DEFAULT_KNOWLEDGE_SKILL,
  };
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
  for (const directory of Object.values(KIND_DIRS)) {
    fs.mkdirSync(path.join(protocolRoot, directory, "shared"), { recursive: true });
  }
  return { created, existing };
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
  return { id, kind: input.kind, scope: input.scope, title, path: relative, owners: [], relations: [] };
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

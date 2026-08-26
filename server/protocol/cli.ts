import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  KNOWLEDGE_KINDS,
  createRepositoryDocument,
  indexRepositoryProtocol,
  initializeRepositoryProtocol,
  validateRepositoryProtocol,
  type IndexedProtocolDocument,
  type KnowledgeKind,
} from "./repository.js";

export interface AyCliIO {
  out(message: string): void;
  err(message: string): void;
}

export interface AyCliDependencies {
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
}

type OptionName = "repository" | "scope" | "title" | "platform" | "task" | "repository-id" | "base-commit";

const VALUE_OPTIONS = new Set<OptionName>([
  "repository",
  "scope",
  "title",
  "platform",
  "task",
  "repository-id",
  "base-commit",
]);

const USAGE = `Alignyard knowledge protocol

Usage:
  ay init [repository]
  ay new <doc|spec|adr> <slug> --scope <scope> [--title <title>] [--repository <path>]
  ay validate [repository] [--json]
  ay sync [repository] [--platform <url>] [--task <AY-key>] [--repository-id <id>]

Commands:
  init       Create the minimal .alignyard scaffold without overwriting files
  new        Create one document from the repository template
  validate   Validate the manifest, templates, Skill, documents, and relations
  sync       Validate and publish the current knowledge snapshot to a Task

Sync environment:
  AY_PLATFORM_URL, AY_TASK_KEY, AY_REPOSITORY_ID, AY_BASE_COMMIT,
  AY_PLATFORM_TOKEN, AY_PLATFORM_TOKEN_FILE, AY_SESSION_TOKEN`;

interface ParsedArguments {
  positionals: string[];
  values: Partial<Record<OptionName, string>>;
  json: boolean;
  help: boolean;
}

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], values: {}, json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const name = argument.slice(2) as OptionName;
      if (!VALUE_OPTIONS.has(name)) throw new Error(`未知选项：${argument}`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 需要一个值`);
      parsed.values[name] = value;
      index += 1;
      continue;
    }
    parsed.positionals.push(argument);
  }
  return parsed;
}

function repositoryRoot(parsed: ParsedArguments, position = 0): string {
  const positional = parsed.positionals[position];
  if (positional && parsed.values.repository) throw new Error("Repository 路径不能同时使用位置参数和 --repository");
  return path.resolve(parsed.values.repository || positional || process.cwd());
}

function assertNoExtraPositionals(parsed: ParsedArguments, expected: number) {
  if (parsed.positionals.length > expected) throw new Error(`参数过多：${parsed.positionals.slice(expected).join(" ")}`);
}

function assertAllowedOptions(parsed: ParsedArguments, allowed: OptionName[], json = false) {
  const supported = new Set<OptionName>(allowed);
  const unexpected = Object.keys(parsed.values).find((name) => !supported.has(name as OptionName));
  if (unexpected) throw new Error(`当前命令不支持 --${unexpected}`);
  if (parsed.json && !json) throw new Error("当前命令不支持 --json");
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function contentAtCommit(root: string, commit: string, filePath: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "show", `${commit}:${filePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function syncDocuments(
  root: string,
  documents: IndexedProtocolDocument[],
  baseCommit: string | null,
) {
  return documents.map((document) => {
    if (!baseCommit) return { ...document, change_kind: "snapshot" };
    const previous = contentAtCommit(root, baseCommit, document.path);
    if (previous == null) return { ...document, change_kind: "added" };
    const previousHash = crypto.createHash("sha256").update(previous).digest("hex");
    return { ...document, change_kind: previousHash === document.content_hash ? "unchanged" : "modified" };
  });
}

function syncValue(
  parsed: ParsedArguments,
  env: Record<string, string | undefined>,
  option: OptionName,
  environment: string[],
): string | undefined {
  return parsed.values[option] || environment.map((name) => env[name]?.trim()).find(Boolean);
}

async function runSync(
  parsed: ParsedArguments,
  io: AyCliIO,
  dependencies: AyCliDependencies,
): Promise<number> {
  assertAllowedOptions(parsed, ["repository", "platform", "task", "repository-id", "base-commit"]);
  assertNoExtraPositionals(parsed, 1);
  const root = repositoryRoot(parsed);
  const env = dependencies.env || process.env;
  const platform = syncValue(parsed, env, "platform", ["AY_PLATFORM_URL", "AY_API_URL"]);
  const taskKey = syncValue(parsed, env, "task", ["AY_TASK_KEY"]);
  const repositoryIdText = syncValue(parsed, env, "repository-id", ["AY_REPOSITORY_ID"]);
  const baseCommit = syncValue(parsed, env, "base-commit", ["AY_BASE_COMMIT"]) || null;
  if (!platform) throw new Error("缺少平台地址；请设置 AY_PLATFORM_URL 或使用 --platform");
  if (!taskKey) throw new Error("缺少 Task；请设置 AY_TASK_KEY 或使用 --task");
  const repositoryId = Number(repositoryIdText);
  if (!Number.isInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("缺少有效的 Repository ID；请设置 AY_REPOSITORY_ID 或使用 --repository-id");
  }

  const indexed = indexRepositoryProtocol(root);
  const headCommit = gitOutput(root, ["rev-parse", "HEAD"]);
  const documents = syncDocuments(root, indexed.documents, baseCommit);
  const endpoint = new URL(`/api/platform/tasks/${encodeURIComponent(taskKey)}/sync`, platform.endsWith("/") ? platform : `${platform}/`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const tokenFile = env.AY_PLATFORM_TOKEN_FILE?.trim();
  const fileToken = tokenFile ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const token = env.AY_PLATFORM_TOKEN?.trim() || fileToken || env.AY_SESSION_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const request = dependencies.fetch || globalThis.fetch;
  const response = await request(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository_id: repositoryId,
      manifest: indexed.manifest,
      base_commit: baseCommit,
      head_commit: headCommit,
      documents,
    }),
  });
  const body = await response.text();
  let result: any = {};
  try { result = body ? JSON.parse(body) : {}; } catch { result = { error: body }; }
  if (!response.ok) throw new Error(result.error || `平台同步失败：HTTP ${response.status}`);
  io.out(JSON.stringify({
    ok: true,
    task: taskKey.toUpperCase(),
    repository_id: repositoryId,
    documents: documents.length,
    head_commit: headCommit,
  }));
  return 0;
}

export async function runAy(
  args: string[],
  io: AyCliIO,
  dependencies: AyCliDependencies = {},
): Promise<number> {
  const [command, ...commandArgs] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 1;
  }

  try {
    const parsed = parseArguments(commandArgs);
    if (parsed.help) {
      io.out(USAGE);
      return 0;
    }
    if (command === "init") {
      assertAllowedOptions(parsed, ["repository"]);
      assertNoExtraPositionals(parsed, 1);
      const root = repositoryRoot(parsed);
      const result = initializeRepositoryProtocol(root);
      io.out(JSON.stringify({ ok: true, repository: root, ...result }));
      return 0;
    }
    if (command === "new") {
      assertAllowedOptions(parsed, ["repository", "scope", "title"]);
      assertNoExtraPositionals(parsed, 2);
      const [kindValue, slug] = parsed.positionals;
      if (!KNOWLEDGE_KINDS.includes(kindValue as KnowledgeKind) || !slug) {
        throw new Error("用法：ay new <doc|spec|adr> <slug> --scope <scope> [--title <title>]");
      }
      const scope = parsed.values.scope?.trim();
      if (!scope) throw new Error("ay new 需要 --scope");
      const root = path.resolve(parsed.values.repository || process.cwd());
      const document = createRepositoryDocument(root, {
        kind: kindValue as KnowledgeKind,
        slug,
        scope,
        title: parsed.values.title,
      });
      io.out(JSON.stringify({ ok: true, repository: root, document }));
      return 0;
    }
    if (command === "validate") {
      assertAllowedOptions(parsed, ["repository"], true);
      assertNoExtraPositionals(parsed, 1);
      const root = repositoryRoot(parsed);
      const result = validateRepositoryProtocol(root);
      if (result.ok) {
        io.out(JSON.stringify({
          ok: true,
          repository: root,
          documents: result.documents.length,
          scopes: result.manifest?.scopes.length || 0,
        }));
        return 0;
      }
      if (parsed.json) io.err(JSON.stringify({ ok: false, repository: root, errors: result.errors }));
      else result.errors.forEach(io.err);
      return 1;
    }
    if (command === "sync") return await runSync(parsed, io, dependencies);
    throw new Error(`未知命令：${command}`);
  } catch (error: any) {
    io.err(String(error?.message || error));
    return 1;
  }
}

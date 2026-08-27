import path from "node:path";
import {
  ALIGNYARD_FRAMEWORK_VERSION,
  KNOWLEDGE_KINDS,
  createRepositoryDocument,
  initializeRepositoryProtocol,
  updateRepositoryFramework,
  validateRepositoryProtocol,
  type KnowledgeKind,
} from "./repository.js";

export interface AyCliIO {
  out(message: string): void;
  err(message: string): void;
}

type OptionName = "repository" | "scope" | "title";

const VALUE_OPTIONS = new Set<OptionName>([
  "repository",
  "scope",
  "title",
]);

const USAGE = `Alignyard knowledge protocol

Usage:
  ay init [repository]
  ay update [repository] [--check]
  ay new <doc|spec|adr|plan> <slug> --scope <scope> [--title <title>] [--repository <path>]
  ay validate [repository] [--json]

Commands:
  init       Create the minimal .alignyard scaffold without overwriting files
  update     Update Alignyard-managed Skill, templates, and protocol structure without replacing knowledge
  new        Create one document from the repository template
  validate   Validate the manifest, templates, Skill, documents, and relations
`;

interface ParsedArguments {
  positionals: string[];
  values: Partial<Record<OptionName, string>>;
  json: boolean;
  check: boolean;
  help: boolean;
}

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], values: {}, json: false, check: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--check") {
      parsed.check = true;
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

function assertAllowedOptions(parsed: ParsedArguments, allowed: OptionName[], options: { json?: boolean; check?: boolean } = {}) {
  const supported = new Set<OptionName>(allowed);
  const unexpected = Object.keys(parsed.values).find((name) => !supported.has(name as OptionName));
  if (unexpected) throw new Error(`当前命令不支持 --${unexpected}`);
  if (parsed.json && !options.json) throw new Error("当前命令不支持 --json");
  if (parsed.check && !options.check) throw new Error("当前命令不支持 --check");
}

export async function runAy(
  args: string[],
  io: AyCliIO,
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
      io.out(JSON.stringify({ ok: true, repository: root, framework_version: ALIGNYARD_FRAMEWORK_VERSION, ...result }));
      return 0;
    }
    if (command === "update") {
      assertAllowedOptions(parsed, ["repository"], { check: true });
      assertNoExtraPositionals(parsed, 1);
      const root = repositoryRoot(parsed);
      const result = updateRepositoryFramework(root, { check: parsed.check });
      io.out(JSON.stringify({ ok: true, update_available: result.changes.length > 0, ...result }));
      return 0;
    }
    if (command === "new") {
      assertAllowedOptions(parsed, ["repository", "scope", "title"]);
      assertNoExtraPositionals(parsed, 2);
      const [kindValue, slug] = parsed.positionals;
      if (!KNOWLEDGE_KINDS.includes(kindValue as KnowledgeKind) || !slug) {
        throw new Error("用法：ay new <doc|spec|adr|plan> <slug> --scope <scope> [--title <title>]");
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
      assertAllowedOptions(parsed, ["repository"], { json: true });
      assertNoExtraPositionals(parsed, 1);
      const root = repositoryRoot(parsed);
      const result = validateRepositoryProtocol(root);
      if (result.ok) {
        io.out(JSON.stringify({
          ok: true,
          repository: root,
          documents: result.documents.length,
          scopes: result.manifest?.scopes.length || 0,
          protocol_version: result.manifest?.version,
          framework_version: result.manifest?.framework_version || 0,
          latest_framework_version: ALIGNYARD_FRAMEWORK_VERSION,
          update_available: (result.manifest?.framework_version || 0) < ALIGNYARD_FRAMEWORK_VERSION,
        }));
        return 0;
      }
      if (parsed.json) io.err(JSON.stringify({ ok: false, repository: root, errors: result.errors }));
      else result.errors.forEach(io.err);
      return 1;
    }
    throw new Error(`未知命令：${command}`);
  } catch (error: any) {
    io.err(String(error?.message || error));
    return 1;
  }
}

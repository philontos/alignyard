import type { CommandRunner } from "../core/command-runner.js";

export type ForgeKind = "github" | "gitlab";
export type RepositoryForgeKind = ForgeKind | "unknown";

export interface ChangeRequestInfo {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
}

export interface ChangeRequestInput {
  runner: CommandRunner;
  cwd: string;
  gitUrl: string;
  baseBranch: string;
  headBranch: string;
}

function gitHost(raw: string): string {
  const value = String(raw || "").trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return new URL(value).hostname.toLowerCase();
  } catch {}
  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):[^/]/);
  return (scp?.[1] || "").toLowerCase();
}

/** Fast, side-effect-free detection for the common public and branded hosts. */
export function repositoryForgeKind(gitUrl: string): RepositoryForgeKind {
  const host = gitHost(gitUrl);
  if (host === "github.com" || host.includes("github")) return "github";
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab";
  return "unknown";
}

function normalizedState(value: unknown, mergedAt?: unknown): ChangeRequestInfo["state"] {
  if (mergedAt || String(value || "").toLowerCase() === "merged") return "merged";
  const state = String(value || "").toLowerCase();
  return state === "closed" ? "closed" : "open";
}

function githubInfo(raw: string): ChangeRequestInfo | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  const number = Number(value?.number);
  const url = typeof value?.url === "string" ? value.url : "";
  if (!Number.isInteger(number) || number <= 0 || !url) return null;
  return { number, url, state: normalizedState(value.state, value.mergedAt) };
}

function gitlabInfo(raw: string): ChangeRequestInfo | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  if (Array.isArray(value)) value = value[0];
  const number = Number(value?.iid);
  const url = typeof value?.web_url === "string"
    ? value.web_url
    : typeof value?.webUrl === "string" ? value.webUrl : "";
  if (!Number.isInteger(number) || number <= 0 || !url) return null;
  return { number, url, state: normalizedState(value.state, value.merged_at ?? value.mergedAt) };
}

function infoFromText(kind: ForgeKind, raw: string): ChangeRequestInfo | null {
  const pattern = kind === "github"
    ? /(https?:\/\/[^\s]+\/pull\/(\d+))/
    : /(https?:\/\/[^\s]+\/-\/merge_requests\/(\d+))/;
  const match = String(raw || "").match(pattern);
  if (!match) return null;
  return { number: Number(match[2]), url: match[1], state: "open" };
}

function commandError(error: unknown): string {
  return String((error as any)?.stderr || (error as any)?.stdout || (error as any)?.message || error).trim();
}

async function probeForge(runner: CommandRunner, cwd: string): Promise<ForgeKind | null> {
  try {
    const raw = await runner.exec("glab", ["repo", "view", "--output", "json"], { cwd });
    const value = JSON.parse(raw);
    if (value && (value.web_url || value.webUrl || value.path_with_namespace)) return "gitlab";
  } catch {}
  try {
    const raw = await runner.exec("gh", ["repo", "view", "--json", "url"], { cwd });
    const value = JSON.parse(raw);
    if (typeof value?.url === "string" && value.url) return "github";
  } catch {}
  return null;
}

/** Resolve branded hosts immediately and use the repository's authenticated
 * local CLI for self-hosted/ambiguous origins. Credentials never leave the
 * owner machine. */
export async function resolveForge(input: Pick<ChangeRequestInput, "runner" | "cwd" | "gitUrl">): Promise<ForgeKind> {
  const detected = repositoryForgeKind(input.gitUrl);
  if (detected !== "unknown") return detected;
  const probed = await probeForge(input.runner, input.cwd);
  if (probed) return probed;
  throw new Error("无法识别代码托管平台；请确认本机 gh 或 glab 已登录并能读取当前 Repository");
}

export function changeRequestLabel(kind: RepositoryForgeKind): "PR" | "MR" | "合并请求" {
  return kind === "github" ? "PR" : kind === "gitlab" ? "MR" : "合并请求";
}

export async function findChangeRequest(
  kind: ForgeKind,
  input: ChangeRequestInput,
  number?: number,
): Promise<ChangeRequestInfo | null> {
  try {
    if (kind === "github") {
      const target = number ? String(number) : input.headBranch;
      const raw = await input.runner.exec("gh", ["pr", "view", target, "--json", "number,url,state"], { cwd: input.cwd });
      return githubInfo(raw);
    }
    const args = number
      ? ["mr", "view", String(number), "--output", "json"]
      : [
          "mr", "list",
          "--source-branch", input.headBranch,
          "--target-branch", input.baseBranch,
          "--output", "json",
          "--per-page", "1",
        ];
    const raw = await input.runner.exec("glab", args, { cwd: input.cwd });
    return gitlabInfo(raw);
  } catch {
    return null;
  }
}

export async function createChangeRequest(
  kind: ForgeKind,
  input: ChangeRequestInput & { title: string; body: string },
): Promise<ChangeRequestInfo> {
  const existing = await findChangeRequest(kind, input);
  // A closed PR/MR is terminal. Reusing it would leave an approved Task with
  // no action, so create a fresh request from the still-owned work branch.
  if (existing && existing.state !== "closed") return existing;

  let output = "";
  try {
    output = kind === "github"
      ? await input.runner.exec("gh", [
          "pr", "create",
          "--base", input.baseBranch,
          "--head", input.headBranch,
          "--title", input.title,
          "--body", input.body,
        ], { cwd: input.cwd })
      : await input.runner.exec("glab", [
          "mr", "create",
          "--source-branch", input.headBranch,
          "--target-branch", input.baseBranch,
          "--title", input.title,
          "--description", input.body,
          "--yes",
        ], { cwd: input.cwd });
  } catch (error) {
    // The external create may have succeeded before the process returned, or a
    // concurrent caller may have won. Reconcile with the forge before failing.
    const reconciled = await findChangeRequest(kind, input);
    const fromError = infoFromText(kind, commandError(error));
    if (reconciled && reconciled.state !== "closed") return reconciled;
    if (fromError) return fromError;
    throw error;
  }

  const reconciled = await findChangeRequest(kind, input);
  const created = reconciled && reconciled.state !== "closed" ? reconciled : infoFromText(kind, output);
  if (!created) throw new Error(`${changeRequestLabel(kind)} 创建后未找到`);
  return created;
}

/** Close an open change request before its platform Task is deleted. GitHub
 * can remove the source branch in the same operation; GitLab closes first and
 * then uses Git for a best-effort remote branch cleanup. */
export async function closeChangeRequest(
  kind: ForgeKind,
  input: ChangeRequestInput,
  number: number,
): Promise<ChangeRequestInfo> {
  const existing = await findChangeRequest(kind, input, number);
  if (!existing) throw new Error(`${changeRequestLabel(kind)} #${number} 未找到`);
  if (existing.state !== "open") return existing;

  try {
    if (kind === "github") {
      await input.runner.exec("gh", ["pr", "close", String(number), "--delete-branch"], { cwd: input.cwd });
    } else {
      await input.runner.exec("glab", ["mr", "close", String(number)], { cwd: input.cwd });
      await input.runner.exec("git", ["push", "origin", "--delete", input.headBranch], { cwd: input.cwd }).catch(() => {});
    }
  } catch (error) {
    const reconciled = await findChangeRequest(kind, input, number);
    if (reconciled?.state === "closed") return reconciled;
    throw error;
  }

  const closed = await findChangeRequest(kind, input, number);
  if (closed?.state !== "closed") throw new Error(`${changeRequestLabel(kind)} #${number} 关闭后状态未确认`);
  return closed;
}

export async function mergeChangeRequest(
  kind: ForgeKind,
  input: ChangeRequestInput,
  number: number,
): Promise<ChangeRequestInfo> {
  const existing = await findChangeRequest(kind, input, number);
  if (existing?.state === "merged") return existing;
  try {
    if (kind === "github") {
      await input.runner.exec("gh", ["pr", "merge", String(number), "--merge"], { cwd: input.cwd });
    } else {
      await input.runner.exec("glab", [
        "mr", "merge", String(number), "--auto-merge=false", "--yes",
      ], { cwd: input.cwd });
    }
  } catch (error) {
    const reconciled = await findChangeRequest(kind, input, number);
    if (reconciled?.state === "merged") return reconciled;
    throw error;
  }
  const result = await findChangeRequest(kind, input, number);
  if (!result) throw new Error(`${changeRequestLabel(kind)} 合并后未找到`);
  return result;
}

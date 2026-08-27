// Read-only worktree inspection, adapted from Switchyard's proven code viewer.
// The browser supplies only a typed operation and a Git-visible relative path;
// the owning Runner resolves the bound Task and never exposes its local path.
import fs from "node:fs";
import path from "node:path";
import type { Task } from "../core/db.js";
import type { LocalExecutor } from "../core/local-executor.js";

export const MAX_WORKTREE_FILE_BYTES = 1024 * 1024;
export const MAX_WORKTREE_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_WORKTREE_TREE_BYTES = 5 * 1024 * 1024;
const MAX_WORKTREE_TREE_FILES = 50000;

export type WorktreeOperation = "tree" | "file" | "changes" | "diff";

export interface WorktreeInspectRequest {
  operation: WorktreeOperation;
  path?: string;
  /** Platform-owned immutable Task baseline. Browser input is never forwarded here. */
  diff_base_commit?: string;
  diff_base_label?: string;
}

interface WorktreeRevision {
  label: string;
  commit: string;
  approximate?: boolean;
}

export interface WorktreeChange {
  path: string;
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?";
  oldPath?: string;
}

export type WorktreePayload =
  | { kind: "tree"; files: string[]; truncated: boolean; revision: WorktreeRevision; generated_at: string }
  | { kind: "file"; path: string; size: number; content: string | null; unavailable?: "binary" | "tooLarge" | "symlink"; revision: WorktreeRevision; generated_at: string }
  | { kind: "changes"; files: WorktreeChange[]; revision: WorktreeRevision; head: string; generated_at: string }
  | { kind: "diff"; path: string; content: string | null; truncated: boolean; binary: boolean; revision: WorktreeRevision; generated_at: string };

export class WorktreeInspectError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WorktreeInspectError";
  }
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

function generatedAt(): string {
  return new Date().toISOString();
}

function visiblePath(value: unknown): string {
  const raw = String(value ?? "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    throw new WorktreeInspectError("invalidPath", "文件路径无效");
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] === ".git") {
    throw new WorktreeInspectError("invalidPath", "文件路径无效");
  }
  return raw;
}

function literalPathspec(value: string): string {
  return `:(top,literal)${value}`;
}

async function git(runner: LocalExecutor, cwd: string, args: string[], maxBuffer?: number): Promise<string> {
  return runner.exec("git", args, { cwd, env: GIT_ENV, maxBuffer });
}

function errorStdout(error: any): string {
  if (typeof error?.stdout === "string") return error.stdout;
  if (Buffer.isBuffer(error?.stdout)) return error.stdout.toString("utf8");
  return "";
}

async function gitCapped(
  runner: LocalExecutor,
  cwd: string,
  args: string[],
  maxBuffer: number,
): Promise<{ text: string; truncated: boolean }> {
  try {
    return { text: await git(runner, cwd, args, maxBuffer), truncated: false };
  } catch (error: any) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer|stdout maxBuffer/i.test(String(error?.message || ""))) {
      return { text: errorStdout(error).slice(0, maxBuffer), truncated: true };
    }
    throw error;
  }
}

function nulFields(text: string, truncated = false): string[] {
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  else if (truncated) fields.pop();
  return fields;
}

async function revision(
  runner: LocalExecutor,
  task: Task,
  request: WorktreeInspectRequest,
): Promise<WorktreeRevision> {
  const requestedBase = String(request.diff_base_commit || "").trim();
  if (requestedBase) {
    if (!/^[0-9a-f]{40,64}$/i.test(requestedBase)) {
      throw new WorktreeInspectError("invalidBase", "Task 记录的 Diff 基线无效");
    }
    try {
      await git(runner, task.worktree_path, ["cat-file", "-e", `${requestedBase}^{commit}`]);
    } catch {
      throw new WorktreeInspectError("baseMissing", "Task 记录的 Diff 基线不在当前 worktree 中，请重新准备 Review 工作区");
    }
    return {
      label: String(request.diff_base_label || task.base_branch || "Task 基线"),
      commit: requestedBase,
    };
  }
  const base = String(task.base_commit || "").trim();
  if (/^[0-9a-f]{40,64}$/i.test(base)) {
    try {
      await git(runner, task.worktree_path, ["cat-file", "-e", `${base}^{commit}`]);
      return { label: task.base_branch, commit: base };
    } catch { /* recover legacy rows below */ }
  }
  for (const ref of [`refs/remotes/origin/${task.base_branch}`, `refs/heads/${task.base_branch}`]) {
    try {
      const commit = (await git(runner, task.worktree_path, ["merge-base", "HEAD", ref])).trim();
      if (commit) return { label: task.base_branch, commit, approximate: true };
    } catch { /* try the next ref */ }
  }
  const head = (await git(runner, task.worktree_path, ["rev-parse", "HEAD"])).trim();
  return { label: task.base_branch, commit: head, approximate: true };
}

async function head(runner: LocalExecutor, task: Task): Promise<string> {
  if (!task.worktree_path || !(await runner.exists(task.worktree_path))) {
    throw new WorktreeInspectError("worktreeGone", "Task worktree 已不存在");
  }
  const commit = (await git(runner, task.worktree_path, ["rev-parse", "HEAD"])).trim();
  if (!commit) throw new WorktreeInspectError("notRepository", "Task worktree 不是 Git Repository");
  return commit;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls++;
  }
  return sample.length > 0 && controls / sample.length > 0.1;
}

function decodeText(buffer: Buffer): string | null {
  if (looksBinary(buffer)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

function readLocalFile(base: string, relative: string): { size: number; buffer?: Buffer; unavailable?: "tooLarge" | "symlink" } {
  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    throw new WorktreeInspectError("worktreeGone", "Task worktree 已不存在");
  }
  const target = path.resolve(realBase, ...relative.split("/"));
  if (!isInside(realBase, target)) throw new WorktreeInspectError("invalidPath", "文件路径无效");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw new WorktreeInspectError("fileMissing", "文件已不存在");
  }
  if (stat.isSymbolicLink()) return { size: stat.size, unavailable: "symlink" };
  if (!stat.isFile()) throw new WorktreeInspectError("fileMissing", "路径不是文件");
  const realTarget = fs.realpathSync(target);
  if (!isInside(realBase, realTarget)) throw new WorktreeInspectError("invalidPath", "文件位于 worktree 之外");
  if (stat.size > MAX_WORKTREE_FILE_BYTES) return { size: stat.size, unavailable: "tooLarge" };
  return { size: stat.size, buffer: fs.readFileSync(realTarget) };
}

async function requireGitVisible(runner: LocalExecutor, task: Task, relative: string): Promise<void> {
  const output = await git(runner, task.worktree_path, [
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", literalPathspec(relative),
  ]);
  if (!nulFields(output).includes(relative)) throw new WorktreeInspectError("fileMissing", "文件不属于当前可见 worktree");
}

function parseNameStatus(text: string): WorktreeChange[] {
  const fields = nulFields(text);
  const changes: WorktreeChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++] || "M";
    const status = rawStatus[0] as WorktreeChange["status"];
    if (status === "R" || status === "C") {
      const oldPath = fields[index++];
      const nextPath = fields[index++];
      if (oldPath && nextPath) changes.push({ path: nextPath, oldPath, status });
    } else {
      const nextPath = fields[index++];
      if (nextPath) changes.push({ path: nextPath, status: ["A", "M", "D", "T", "U"].includes(status) ? status : "M" });
    }
  }
  return changes;
}

async function changes(runner: LocalExecutor, task: Task, request: WorktreeInspectRequest) {
  const currentHead = await head(runner, task);
  const base = await revision(runner, task, request);
  const tracked = await git(runner, task.worktree_path, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--name-status", "-z", base.commit, "--",
  ]);
  const files = parseNameStatus(tracked);
  const seen = new Set(files.map((file) => file.path));
  const untracked = await git(runner, task.worktree_path, ["ls-files", "-z", "--others", "--exclude-standard"]);
  for (const relative of nulFields(untracked)) {
    if (relative && !seen.has(relative)) files.push({ path: relative, status: "?" });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { kind: "changes" as const, files, revision: base, head: currentHead, generated_at: generatedAt() };
}

function untrackedPatch(relative: string, content: string): string {
  const lines = content.split("\n");
  const finalNewline = content.endsWith("\n");
  if (finalNewline) lines.pop();
  let patch = `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n`;
  if (lines.length) patch += `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  if (lines.length && !finalNewline) patch += "\\ No newline at end of file\n";
  return patch;
}

async function completeDiff(
  runner: LocalExecutor,
  task: Task,
  changed: Awaited<ReturnType<typeof changes>>,
): Promise<WorktreePayload> {
  const tracked = await gitCapped(runner, task.worktree_path, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3",
    changed.revision.commit, "--",
  ], MAX_WORKTREE_DIFF_BYTES);
  let content = tracked.text;
  let truncated = tracked.truncated;
  for (const change of changed.files.filter((file) => file.status === "?")) {
    if (truncated) break;
    await requireGitVisible(runner, task, change.path);
    const read = readLocalFile(task.worktree_path, change.path);
    const decoded = read.buffer ? decodeText(read.buffer) : null;
    let patch: string;
    if (read.unavailable === "tooLarge") {
      patch = `diff --git a/${change.path} b/${change.path}\nnew file is too large to preview\n`;
    } else if (read.unavailable || decoded == null) {
      patch = `diff --git a/${change.path} b/${change.path}\nBinary files /dev/null and b/${change.path} differ\n`;
    } else {
      patch = untrackedPatch(change.path, decoded);
    }
    const separator = content && !content.endsWith("\n") ? "\n" : "";
    const remaining = MAX_WORKTREE_DIFF_BYTES - content.length - separator.length;
    if (patch.length > remaining) {
      content += separator + patch.slice(0, Math.max(0, remaining));
      truncated = true;
    } else {
      content += separator + patch;
    }
  }
  return {
    kind: "diff",
    path: "",
    content,
    truncated,
    binary: false,
    revision: changed.revision,
    generated_at: generatedAt(),
  };
}

export async function inspectTaskWorktree(
  runner: LocalExecutor,
  task: Task,
  request: WorktreeInspectRequest,
): Promise<WorktreePayload> {
  if (task.kind === "local" || !task.repo_id) throw new WorktreeInspectError("notRepoTask", "当前 Task 没有 Repository worktree");
  const currentHead = await head(runner, task);
  if (request.operation === "tree") {
    const output = await gitCapped(runner, task.worktree_path, [
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ], MAX_WORKTREE_TREE_BYTES);
    const all = nulFields(output.text, output.truncated).filter((file) => file && !file.startsWith(".git/"));
    const truncated = output.truncated || all.length > MAX_WORKTREE_TREE_FILES;
    return {
      kind: "tree",
      files: all.slice(0, MAX_WORKTREE_TREE_FILES),
      truncated,
      revision: { label: task.work_branch || task.base_branch, commit: currentHead },
      generated_at: generatedAt(),
    };
  }
  if (request.operation === "changes") return changes(runner, task, request);

  if (request.operation === "diff" && !request.path) {
    const changed = await changes(runner, task, request);
    return completeDiff(runner, task, changed);
  }

  const relative = visiblePath(request.path);
  if (request.operation === "file") {
    await requireGitVisible(runner, task, relative);
    const read = readLocalFile(task.worktree_path, relative);
    if (read.unavailable) {
      return {
        kind: "file", path: relative, size: read.size, content: null, unavailable: read.unavailable,
        revision: { label: task.work_branch || task.base_branch, commit: currentHead }, generated_at: generatedAt(),
      };
    }
    const content = read.buffer ? decodeText(read.buffer) : null;
    return {
      kind: "file", path: relative, size: read.size, content,
      ...(content == null ? { unavailable: "binary" as const } : {}),
      revision: { label: task.work_branch || task.base_branch, commit: currentHead }, generated_at: generatedAt(),
    };
  }
  if (request.operation !== "diff") throw new WorktreeInspectError("invalidOperation", "不支持的 worktree 操作");

  const changed = await changes(runner, task, request);
  const change = changed.files.find((file) => file.path === relative || file.oldPath === relative);
  if (!change) throw new WorktreeInspectError("fileUnchanged", "文件相对 Task 基线没有变化");
  if (change.status === "?") {
    await requireGitVisible(runner, task, relative);
    const read = readLocalFile(task.worktree_path, relative);
    if (read.unavailable || !read.buffer) {
      return {
        kind: "diff", path: relative, content: null, truncated: read.unavailable === "tooLarge",
        binary: read.unavailable !== "tooLarge", revision: changed.revision, generated_at: generatedAt(),
      };
    }
    const text = decodeText(read.buffer);
    if (text == null) return { kind: "diff", path: relative, content: null, truncated: false, binary: true, revision: changed.revision, generated_at: generatedAt() };
    const patch = untrackedPatch(relative, text);
    return {
      kind: "diff", path: relative, content: patch.slice(0, MAX_WORKTREE_DIFF_BYTES),
      truncated: patch.length > MAX_WORKTREE_DIFF_BYTES, binary: false,
      revision: changed.revision, generated_at: generatedAt(),
    };
  }

  const paths = [change.oldPath, change.path].filter((value): value is string => !!value).map(literalPathspec);
  const output = await gitCapped(runner, task.worktree_path, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3",
    changed.revision.commit, "--", ...paths,
  ], MAX_WORKTREE_DIFF_BYTES);
  const binary = /(?:Binary files .* differ|GIT binary patch)/.test(output.text);
  return {
    kind: "diff", path: change.path, content: binary ? null : output.text,
    truncated: output.truncated, binary, revision: changed.revision, generated_at: generatedAt(),
  };
}

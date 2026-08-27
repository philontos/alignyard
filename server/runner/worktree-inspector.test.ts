import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task } from "../core/db.ts";
import type { ExecOpts } from "../core/command-runner.ts";
import type { LocalExecutor } from "../core/local-executor.ts";
import { inspectTaskWorktree } from "./worktree-inspector.ts";

const pexec = promisify(execFile);

class TestExecutor implements LocalExecutor {
  kind = "local" as const;
  dataDir = "/tmp";
  async exec(file: string, args: string[], opts: ExecOpts = {}) {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });
    return stdout;
  }
  async mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async exists(target: string) { return fs.existsSync(target); }
  async readText(target: string) { try { return fs.readFileSync(target, "utf8"); } catch { return null; } }
  async rmrf(target: string) { fs.rmSync(target, { recursive: true, force: true }); }
  async putDir(source: string, target: string) { fs.cpSync(source, target, { recursive: true }); }
  async putFile(source: string, target: string) { fs.copyFileSync(source, target); }
}

const runner = new TestExecutor();

async function git(cwd: string, ...args: string[]) {
  return (await runner.exec("git", args, { cwd })).trim();
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-worktree-view-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, ".alignyard", "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret.env\n");
  fs.writeFileSync(path.join(dir, ".alignyard", "repository.yaml"), "version: 2\n");
  fs.writeFileSync(path.join(dir, ".alignyard", "docs", "overview.md"), "# 仓库概览\n\n初始内容。\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const base = await git(dir, "rev-parse", "HEAD");
  const task = {
    id: 1,
    repo_id: 1,
    base_branch: "main",
    base_commit: base,
    work_branch: "change/ay-001/test",
    title: "test",
    prompt: null,
    worktree_path: dir,
    session: "ay-test",
    status: "running",
    error: null,
    created_at: "now",
    kind: "repo",
    host_id: 1,
    cwd: null,
    agent: "codex",
    agent_model: null,
  } satisfies Task;
  return { dir, base, task };
}

test("worktree browser lists Git-visible files and reads UTF-8 documents", async () => {
  const current = await fixture();
  try {
    fs.writeFileSync(path.join(current.dir, "secret.env"), "TOKEN=hidden\n");
    const tree = await inspectTaskWorktree(runner, current.task, { operation: "tree" });
    assert.equal(tree.kind, "tree");
    if (tree.kind !== "tree") return;
    assert.ok(tree.files.includes(".alignyard/docs/overview.md"));
    assert.ok(!tree.files.includes("secret.env"));

    const file = await inspectTaskWorktree(runner, current.task, {
      operation: "file",
      path: ".alignyard/docs/overview.md",
    });
    assert.equal(file.kind, "file");
    if (file.kind === "file") assert.match(file.content || "", /仓库概览/);
    await assert.rejects(
      inspectTaskWorktree(runner, current.task, { operation: "file", path: "../.git/config" }),
      /文件路径无效/,
    );
    await assert.rejects(
      inspectTaskWorktree(runner, current.task, { operation: "file", path: "secret.env" }),
      /可见 worktree/,
    );
  } finally {
    fs.rmSync(current.dir, { recursive: true, force: true });
  }
});

test("worktree browser diffs committed, deleted and untracked files against immutable Task base", async () => {
  const current = await fixture();
  try {
    fs.writeFileSync(path.join(current.dir, ".alignyard", "docs", "overview.md"), "# 仓库概览\n\n更新内容。\n");
    await git(current.dir, "add", ".alignyard/docs/overview.md");
    await git(current.dir, "commit", "-m", "update docs");
    const authorHead = await git(current.dir, "rev-parse", "HEAD");
    fs.rmSync(path.join(current.dir, "README.md"));
    fs.writeFileSync(path.join(current.dir, ".alignyard", "docs", "new.md"), "# 新文档\n");

    const changes = await inspectTaskWorktree(runner, current.task, { operation: "changes" });
    assert.equal(changes.kind, "changes");
    if (changes.kind !== "changes") return;
    assert.deepEqual(changes.files.map((file) => [file.status, file.path]), [
      ["?", ".alignyard/docs/new.md"],
      ["M", ".alignyard/docs/overview.md"],
      ["D", "README.md"],
    ]);
    assert.equal(changes.revision.commit, current.base);

    const complete = await inspectTaskWorktree(runner, current.task, { operation: "diff" });
    assert.equal(complete.kind, "diff");
    if (complete.kind === "diff") {
      assert.equal(complete.path, "");
      assert.equal(complete.revision.commit, current.base);
      assert.match(complete.content || "", /更新内容/);
      assert.match(complete.content || "", /README\.md/);
      assert.match(complete.content || "", /\+# 新文档/);
    }

    const committed = await inspectTaskWorktree(runner, current.task, {
      operation: "diff",
      path: ".alignyard/docs/overview.md",
    });
    assert.equal(committed.kind, "diff");
    if (committed.kind === "diff") {
      assert.match(committed.content || "", /初始内容/);
      assert.match(committed.content || "", /更新内容/);
    }

    const added = await inspectTaskWorktree(runner, current.task, {
      operation: "diff",
      path: ".alignyard/docs/new.md",
    });
    assert.equal(added.kind, "diff");
    if (added.kind === "diff") assert.match(added.content || "", /\+# 新文档/);

    // Reviewer worktrees start from Author HEAD. The Platform-supplied Task
    // baseline must still make the complete review Diff relative to main.
    current.task.base_commit = authorHead;
    current.task.base_branch = "change/ay-001/test";
    const reviewChanges = await inspectTaskWorktree(runner, current.task, {
      operation: "changes",
      diff_base_commit: current.base,
      diff_base_label: "main",
    });
    assert.equal(reviewChanges.kind, "changes");
    if (reviewChanges.kind === "changes") {
      assert.equal(reviewChanges.revision.commit, current.base);
      assert.equal(reviewChanges.revision.label, "main");
      assert.ok(reviewChanges.files.some((file) => file.path === ".alignyard/docs/overview.md"));
    }
  } finally {
    fs.rmSync(current.dir, { recursive: true, force: true });
  }
});

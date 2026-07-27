import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { Task } from "../core/db.ts";
import type { Runner } from "../fleet/runner.ts";
import { parseKimiLine, readTranscript } from "./transcript.ts";

function task(agent: Task["agent"] = "kimi"): Task {
  return {
    id: 7, repo_id: 1, base_branch: "main", base_commit: null,
    work_branch: "feat/7", title: "transcript", prompt: null,
    worktree_path: "/worktrees/7", session: "tdsp-7", status: "running", error: null,
    created_at: "now", kind: "repo", host_id: null, cwd: null,
    claude_session: null, provider_id: null, agent, agent_model: null,
  };
}

test("transcript reading refuses a remote runner", async () => {
  const remote = { kind: "ssh" } as Runner;
  await assert.rejects(() => readTranscript(remote, task("claude")), /node that owns the task/);
});

test("parseKimiLine maps visible messages and loop events while dropping injected context", () => {
  assert.deepEqual(parseKimiLine({
    type: "context.append_message",
    message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "hello" }] },
  }), [{ t: "user", text: "hello" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_message",
    message: { role: "user", origin: { kind: "injection", variant: "todo_list_reminder" }, content: [{ type: "text", text: "internal" }] },
  }), []);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "think", think: "checking" } },
  }), [{ t: "thinking", text: "checking" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "done" } },
  }), [{ t: "assistant", text: "done" }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: { type: "tool.call", toolCallId: "tc-1", name: "Bash", args: { command: "npm test" } },
  }), [{
    t: "tool_call", id: "tc-1", name: "Bash", arg: "npm test",
    detail: "{\n  \"command\": \"npm test\"\n}",
  }]);
  assert.deepEqual(parseKimiLine({
    type: "context.append_loop_event",
    event: {
      type: "tool.result", toolCallId: "tc-1",
      result: { output: [{ type: "text", text: "ok\n" }, { type: "image", imageUrl: { url: "blobref:image/png;x" } }], isError: true },
    },
  }), [{ t: "tool_result", id: "tc-1", ok: false, output: "ok\n[image]" }]);
  assert.deepEqual(parseKimiLine({ type: "turn.prompt", input: [{ type: "text", text: "hello" }] }), []);
});

test("readTranscript locates the most recently active Kimi session, tails it, and follows a new source", async () => {
  const kimiHome = path.join(os.homedir(), ".kimi-code");
  const firstDir = path.join(kimiHome, "sessions", "wd-7", "session-first");
  const secondDir = path.join(kimiHome, "sessions", "wd-7", "session-second");
  const firstWire = path.join(firstDir, "agents", "main", "wire.jsonl");
  const secondWire = path.join(secondDir, "agents", "main", "wire.jsonl");
  const firstBody = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "first prompt" }] } },
    { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "first answer" } } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const secondBody = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "new prompt" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";

  let index = JSON.stringify({ sessionId: "session-first", sessionDir: firstDir, workDir: "/worktrees/7" }) + "\n";
  const textFiles = new Map<string, string>([
    [path.join(firstDir, "state.json"), JSON.stringify({ workDir: "/worktrees/7", updatedAt: "2026-07-27T01:00:00Z" })],
    [path.join(secondDir, "state.json"), JSON.stringify({ workDir: "/worktrees/7", updatedAt: "2026-07-27T02:00:00Z" })],
  ]);
  const wireFiles = new Map<string, string>([[firstWire, firstBody], [secondWire, secondBody]]);
  const runner = {
    kind: "local" as const,
    dataDir: "/data",
    async exec(file: string, args: string[]) {
      const wire = wireFiles.get(args.at(-1) || "");
      if (file === "wc" && wire != null) return `${Buffer.byteLength(wire, "utf8")} ${args.at(-1)}\n`;
      if (file === "tail" && wire != null) {
        const from = Math.max(0, Number((args[1] || "+1").slice(1)) - 1);
        return Buffer.from(wire, "utf8").subarray(from).toString("utf8");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    },
    async exists(p: string) { return wireFiles.has(p); },
    async readText(p: string) {
      if (p === path.join(kimiHome, "session_index.jsonl")) return index;
      return textFiles.get(p) ?? null;
    },
    async mkdirp() {},
    async rmrf() {},
    async putDir() {},
    async putFile() {},
  } satisfies Runner;

  const first = await readTranscript(runner, task());
  assert.equal(first.source, firstWire);
  assert.deepEqual(first.entries, [
    { t: "user", text: "first prompt" },
    { t: "assistant", text: "first answer" },
  ]);
  assert.equal(first.cursor, Buffer.byteLength(firstBody, "utf8"));

  const unchanged = await readTranscript(runner, task(), first.cursor, first.source);
  assert.deepEqual(unchanged.entries, []);
  assert.equal(unchanged.cursor, first.cursor);

  index += JSON.stringify({ sessionId: "session-second", sessionDir: secondDir, workDir: "/worktrees/7" }) + "\n";
  const switched = await readTranscript(runner, task(), first.cursor, first.source);
  assert.equal(switched.source, secondWire);
  assert.deepEqual(switched.entries, [{ t: "user", text: "new prompt" }]);
  assert.equal(switched.cursor, Buffer.byteLength(secondBody, "utf8"));
});

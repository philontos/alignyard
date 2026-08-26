import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlatformRunnerMessage, parseRunnerInboundMessage } from "./protocol.ts";

const capabilities = {
  git: true,
  tmux: true,
  ssh: true,
  agents: { codex: true, claude: false, kimi: false },
  forge: { gh: true, glab: false },
};

test("Runner inbound parser requires a complete typed hello", () => {
  assert.ok(parseRunnerInboundMessage(JSON.stringify({
    type: "runner.hello", protocol_version: 1, capabilities,
  })));
  assert.equal(parseRunnerInboundMessage(JSON.stringify({
    type: "runner.hello", protocol_version: 1, capabilities: { git: true },
  })), null);
});

test("Runner inbound parser rejects invalid execution states and terminal payloads", () => {
  assert.equal(parseRunnerInboundMessage(JSON.stringify({
    type: "execution.event", execution_id: "rex_valid123", status: "owned",
  })), null);
  assert.equal(parseRunnerInboundMessage(JSON.stringify({
    type: "terminal.data", channel: "term_1", data: 42,
  })), null);
  assert.ok(parseRunnerInboundMessage(JSON.stringify({
    type: "terminal.data", channel: "term_1", data: "output",
  })));
});

test("Platform message parser enforces the RPC allowlist and terminal bounds", () => {
  assert.ok(parsePlatformRunnerMessage(JSON.stringify({
    type: "rpc.request", id: "rpc_1", method: "execution.status", params: {},
  })));
  assert.equal(parsePlatformRunnerMessage(JSON.stringify({
    type: "rpc.request", id: "rpc_1", method: "shell.exec", params: {},
  })), null);
  assert.equal(parsePlatformRunnerMessage(JSON.stringify({
    type: "terminal.resize", channel: "term_1", cols: 1_001, rows: 40,
  })), null);
});

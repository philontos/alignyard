import { test } from "node:test";
import assert from "node:assert/strict";
import { executionWebSocketUrl } from "./core/pty-socket.js";

test("Platform terminals address only a scoped Runner execution", () => {
  assert.equal(
    executionWebSocketUrl("rex_one", { protocol: "http:", host: "localhost:14580" }),
    "ws://localhost:14580/pty?execution=rex_one",
  );
  assert.equal(
    executionWebSocketUrl("rex/a", { protocol: "https:", host: "node.example" }),
    "wss://node.example/pty?execution=rex%2Fa",
  );
});

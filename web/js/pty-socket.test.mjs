import { test } from "node:test";
import assert from "node:assert/strict";
import { ptyWebSocketUrl } from "./core/pty-socket.js";

test("product terminals share the owner-local PTY relay URL", () => {
  assert.equal(
    ptyWebSocketUrl("session=tdsp-1", "zh-CN", { protocol: "http:", host: "localhost:14580" }),
    "ws://localhost:14580/pty?session=tdsp-1&lang=zh-CN",
  );
  assert.equal(
    ptyWebSocketUrl("session=tdsp-1", "en", { protocol: "https:", host: "node.example" }),
    "wss://node.example/pty?session=tdsp-1&lang=en",
  );
});

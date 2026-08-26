import test from "node:test";
import assert from "node:assert/strict";
import { activateCanvasRenderer } from "./terminal-renderer.js";

test("activates the official canvas renderer when its vendored addon is available", () => {
  class CanvasAddon {}
  const loaded = [];
  const term = { loadAddon: (addon) => loaded.push(addon) };
  assert.equal(activateCanvasRenderer(term, { CanvasAddon }), true);
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0] instanceof CanvasAddon);
});

test("keeps the DOM renderer as a fallback when canvas is unavailable", () => {
  assert.equal(activateCanvasRenderer({ loadAddon() {} }, {}), false);
});

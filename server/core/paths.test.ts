import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDataDir } from "./paths.js";

const HOME = "/home/u";

test("defaults to ~/.alignyard/runtime when no override is set", () => {
  assert.equal(resolveDataDir({}, HOME), path.join(HOME, ".alignyard", "runtime"));
});

test("ALIGNYARD_DATA_DIR overrides the default", () => {
  assert.equal(
    resolveDataDir({ ALIGNYARD_DATA_DIR: "/srv/alignyard" }, HOME),
    "/srv/alignyard",
  );
});

test("the historical data-dir variable remains an upgrade alias", () => {
  assert.equal(resolveDataDir({ TASK_DISPATCHER_DATA_DIR: "/srv/legacy" }, HOME), "/srv/legacy");
});

test("a relative override is resolved to an absolute path", () => {
  assert.equal(
    resolveDataDir({ ALIGNYARD_DATA_DIR: "data-dev" }, HOME),
    path.resolve("data-dev"),
  );
});

test("a blank / whitespace override falls back to the default", () => {
  assert.equal(resolveDataDir({ ALIGNYARD_DATA_DIR: "" }, HOME), path.join(HOME, ".alignyard", "runtime"));
  assert.equal(resolveDataDir({ ALIGNYARD_DATA_DIR: "   " }, HOME), path.join(HOME, ".alignyard", "runtime"));
});

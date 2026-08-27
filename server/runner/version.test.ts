import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runnerVersion } from "./version.ts";

test("Runner version comes from its independent release file", () => {
  const expected = fs.readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim();
  assert.match(expected, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(runnerVersion(), expected);
});

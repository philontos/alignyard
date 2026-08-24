import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const main = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");

test("the platform runtime link opens the requested local agent task after boot", () => {
  assert.match(main, /url\.searchParams\.get\("task"\)/);
  assert.match(main, /connect\(requestedTask\)/);
  assert.match(main, /url\.searchParams\.delete\("task"\)/);
});

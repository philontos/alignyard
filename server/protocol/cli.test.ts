import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAy } from "./cli.ts";

function temporaryRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-ay-"));
}

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (message: string) => out.push(message), err: (message: string) => err.push(message) } };
}

test("ay init, new, and validate form a runnable protocol loop", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    assert.equal(await runAy(["init", root], result.io), 0);
    assert.equal(await runAy([
      "new", "doc", "overview", "--scope", "shared", "--title", "Repository Overview", "--repository", root,
    ], result.io), 0);
    assert.equal(await runAy([
      "new", "spec", "login-flow", "--scope", "shared", "--title", "Login Flow", "--repository", root,
    ], result.io), 0);
    assert.equal(await runAy(["validate", root], result.io), 0);
    assert.equal(result.err.length, 0);
    assert.match(result.out[3], /"documents":3/);
    assert.match(
      fs.readFileSync(path.join(root, ".alignyard/specs/shared/login-flow.md"), "utf8"),
      /id: spec\.shared\.login-flow[\s\S]*title: "Login Flow"/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay new refuses undeclared scopes and existing paths", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    await runAy(["init", root], result.io);
    assert.equal(await runAy(["new", "doc", "overview", "--scope", "web", "--repository", root], result.io), 1);
    assert.match(result.err.at(-1) || "", /未在 repository.yaml 中声明/);
    assert.equal(await runAy(["new", "doc", "overview", "--scope", "shared", "--repository", root], result.io), 0);
    assert.equal(await runAy(["new", "doc", "overview", "--scope", "shared", "--repository", root], result.io), 1);
    assert.match(result.err.at(-1) || "", /已存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay update check previews framework drift before applying an idempotent update", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    await runAy(["init", root], result.io);
    const skill = path.join(root, ".alignyard/skills/alignyard-knowledge/SKILL.md");
    fs.writeFileSync(skill, "legacy skill\n", "utf8");
    assert.equal(await runAy(["update", root, "--check"], result.io), 0);
    assert.match(result.out.at(-1) || "", /"update_available":true/);
    assert.equal(fs.readFileSync(skill, "utf8"), "legacy skill\n");
    assert.equal(await runAy(["update", root], result.io), 0);
    assert.match(fs.readFileSync(skill, "utf8"), /Framework update/);
    assert.equal(await runAy(["update", root, "--check"], result.io), 0);
    assert.match(result.out.at(-1) || "", /"update_available":false/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

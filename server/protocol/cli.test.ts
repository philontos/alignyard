import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { runAy } from "./cli.ts";

function temporaryRepository() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-ay-"));
}

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (message: string) => out.push(message), err: (message: string) => err.push(message) } };
}

function metadata(root: string, relative: string) {
  const content = fs.readFileSync(path.join(root, ".alignyard", relative), "utf8");
  return YAML.parse(content.split("---")[1]);
}

test("business constraint Docs and ADRs use the target Git identity, with an editable override", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "config", "user.name", "Example Recorder"]);
    await runAy(["init", root], result.io);
    for (const args of [
      ["doc", "overview"], ["doc", "business-rule", "--constraint"], ["adr", "business-choice"], ["spec", "change"],
    ]) {
      assert.equal(await runAy(["new", ...args, "--scope", "shared", "--repository", root], result.io), 0, result.err.join("\n"));
    }
    assert.equal(metadata(root, "docs/shared/business-rule.md").author, "Example Recorder");
    assert.equal(metadata(root, "adrs/shared/business-choice.md").author, "Example Recorder");
    assert.equal(metadata(root, "docs/shared/overview.md").author, undefined);
    assert.equal(metadata(root, "specs/shared/change.md").author, undefined);
    const signedDoc = fs.readFileSync(path.join(root, ".alignyard/docs/shared/business-rule.md"), "utf8");
    assert.match(signedDoc, /# 业务关键约束/);
    assert.match(signedDoc, /# 适用范围/);
    const name = 'Example: "Contact"\nSecond line';
    assert.equal(await runAy([
      "new", "adr", "override", "--author", name, "--scope", "shared", "--repository", root,
    ], result.io), 0);
    assert.equal(metadata(root, "adrs/shared/override.md").author, name);
    assert.equal(await runAy([
      "new", "adr", "unsigned", "--author", "", "--scope", "shared", "--repository", root,
    ], result.io), 0);
    assert.equal(metadata(root, "adrs/shared/unsigned.md").author, "");
    assert.equal(await runAy(["validate", root], result.io), 0, result.err.join("\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing Git identity does not block creation or mutate Git configuration", async () => {
  const root = temporaryRepository();
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    const configPath = path.join(root, ".git/config");
    const before = fs.readFileSync(configPath, "utf8");
    const result = output();
    await runAy(["init", root], result.io);
    execFileSync(process.execPath, [
      "--import", "tsx", "server/ay.ts", "new", "adr", "unsigned", "--scope", "shared", "--repository", root,
    ], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" } });
    assert.equal(metadata(root, "adrs/shared/unsigned.md").author, "");
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("signature options cannot silently alter unrelated document kinds or commands", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    await runAy(["init", root], result.io);
    for (const args of [
      ["new", "spec", "wrong", "--scope", "shared", "--constraint"],
      ["new", "doc", "wrong", "--scope", "shared", "--author", "Example"],
      ["validate", "--constraint"],
    ]) {
      assert.equal(await runAy([...args, "--repository", root], result.io), 1);
    }
    assert.equal(fs.existsSync(path.join(root, ".alignyard/specs/shared/wrong.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test("ay new plan renders phased checkbox task scaffolding", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    await runAy(["init", root], result.io);
    assert.equal(await runAy([
      "new", "plan", "login-flow", "--scope", "shared", "--title", "Login Plan", "--repository", root,
    ], result.io), 0);
    const plan = fs.readFileSync(path.join(root, ".alignyard/plans/shared/login-flow.md"), "utf8");
    assert.match(plan, /# 实施任务/);
    assert.match(plan, /## P0 契约与基础结构/);
    assert.match(plan, /- \[ \] P0\.1/);
    assert.match(plan, /## P1 核心实现/);
    assert.match(plan, /- 验证结果：待执行/);
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

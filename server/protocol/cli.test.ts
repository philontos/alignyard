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
    assert.match(result.out[3], /"documents":2/);
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

test("ay sync validates and posts the bounded knowledge snapshot", async () => {
  const root = temporaryRepository();
  const result = output();
  let requestUrl = "";
  let requestBody: any;
  try {
    await runAy(["init", root], result.io);
    await runAy(["new", "doc", "overview", "--scope", "shared", "--repository", root], result.io);
    const tokenFile = path.join(root, "execution-token");
    fs.writeFileSync(tokenFile, "secret\n", { mode: 0o600 });
    const code = await runAy(["sync", root], result.io, {
      env: {
        AY_PLATFORM_URL: "http://127.0.0.1:14599",
        AY_TASK_KEY: "AY-007",
        AY_REPOSITORY_ID: "12",
        AY_PLATFORM_TOKEN_FILE: tokenFile,
      },
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    assert.equal(code, 0);
    assert.equal(requestUrl, "http://127.0.0.1:14599/api/platform/tasks/AY-007/sync");
    assert.equal(requestBody.repository_id, 12);
    assert.equal(requestBody.manifest.version, 1);
    assert.equal(requestBody.documents.length, 1);
    assert.equal(requestBody.documents[0].change_kind, "snapshot");
    assert.equal(requestBody.documents[0].content_hash.length, 64);
    assert.match(result.out.at(-1) || "", /"documents":1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ay sync reports missing runtime context without contacting a platform", async () => {
  const root = temporaryRepository();
  const result = output();
  try {
    await runAy(["init", root], result.io);
    assert.equal(await runAy(["sync", root], result.io, { env: {} }), 1);
    assert.match(result.err.at(-1) || "", /AY_PLATFORM_URL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

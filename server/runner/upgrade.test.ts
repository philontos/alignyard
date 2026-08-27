import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareRunnerVersions,
  parseRunnerReleaseManifest,
  upgradeRunner,
} from "./upgrade.ts";

test("Runner release manifests and version ordering reject unsafe updates", () => {
  const valid = {
    version: "0.1.1", node_version: "22.0.0", os: "darwin", arch: "arm64",
    size: 10, sha256: "a".repeat(64),
  };
  assert.equal(parseRunnerReleaseManifest(valid, "arm64").version, "0.1.1");
  assert.throws(() => parseRunnerReleaseManifest({ ...valid, version: "../../bad" }, "arm64"), /清单无效/);
  assert.throws(() => parseRunnerReleaseManifest({ ...valid, arch: "x64" }, "arm64"), /清单无效/);
  assert.ok(compareRunnerVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareRunnerVersions("0.2.0", "0.2.0-beta.1") > 0);
  assert.equal(compareRunnerVersions("0.2.0", "0.2.0"), 0);
});

test("upgrade installs a verified release, switches stable launchers and keeps the old release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-upgrade-test."));
  try {
    const home = path.join(root, "home");
    const oldRoot = path.join(home, ".alignyard", "app", "0.1.0");
    fs.mkdirSync(path.join(oldRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, "VERSION"), "0.1.0\n");
    fs.writeFileSync(path.join(oldRoot, "bin", "alignyard-runner"), "old\n");

    const source = path.join(root, "source", "alignyard-runner");
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.writeFileSync(path.join(source, "VERSION"), "0.1.1\n");
    fs.writeFileSync(path.join(source, "bin", "alignyard-runner"), "new runner\n");
    fs.writeFileSync(path.join(source, "bin", "ay"), "new ay\n");
    const archivePath = path.join(root, "alignyard-runner.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(source), "alignyard-runner"]);
    const archive = fs.readFileSync(archivePath);
    const manifest = {
      version: "0.1.1", node_version: "22.0.0", os: "darwin", arch: "arm64",
      size: archive.length, sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("manifest.json")
        ? new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(archive, { status: 200 });
    }) as typeof fetch;

    const result = await upgradeRunner({
      platform_url: "https://ay.example.com", runner_id: "run_1", token: "secret", name: "Mac",
    }, { home, currentRoot: oldRoot, platform: "darwin", arch: "arm64", fetchImpl });

    assert.equal(result.updated, true);
    assert.equal(result.from, "0.1.0");
    assert.equal(result.to, "0.1.1");
    assert.equal(fs.readFileSync(path.join(oldRoot, "VERSION"), "utf8").trim(), "0.1.0");
    assert.equal(fs.readFileSync(path.join(result.install_root, "VERSION"), "utf8").trim(), "0.1.1");
    assert.equal(
      fs.realpathSync(path.join(home, ".local", "bin", "alignyard-runner")),
      fs.realpathSync(path.join(result.install_root, "bin", "alignyard-runner")),
    );
    assert.equal(
      fs.realpathSync(path.join(home, ".local", "bin", "ay")),
      fs.realpathSync(path.join(result.install_root, "bin", "ay")),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

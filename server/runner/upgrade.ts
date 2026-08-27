import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerConfig } from "./config.js";

const pexec = promisify(execFile);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT_SIZE = 1024 * 1024 * 1024;

export interface RunnerReleaseManifest {
  version: string;
  node_version: string;
  os: "darwin";
  arch: "arm64" | "x64";
  size: number;
  sha256: string;
}

export interface UpgradeRunnerOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  currentRoot?: string;
  fetchImpl?: typeof fetch;
}

export interface UpgradeRunnerResult {
  updated: boolean;
  from: string;
  to: string;
  install_root: string;
}

function releaseArch(arch: NodeJS.Architecture): RunnerReleaseManifest["arch"] {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  throw new Error(`当前 Runner 不支持 ${arch} 架构`);
}

export function parseRunnerReleaseManifest(
  value: unknown,
  expectedArch: RunnerReleaseManifest["arch"],
): RunnerReleaseManifest {
  const manifest = value as Partial<RunnerReleaseManifest> | null;
  if (!manifest || manifest.os !== "darwin" || manifest.arch !== expectedArch
    || typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)
    || typeof manifest.node_version !== "string" || !manifest.node_version.trim()
    || !Number.isSafeInteger(manifest.size) || manifest.size! <= 0 || manifest.size! > MAX_ARTIFACT_SIZE
    || typeof manifest.sha256 !== "string" || !SHA256_PATTERN.test(manifest.sha256)) {
    throw new Error("Runner 发布清单无效");
  }
  return manifest as RunnerReleaseManifest;
}

function versionParts(value: string): { numbers: number[]; prerelease: string | null } | null {
  if (!VERSION_PATTERN.test(value)) return null;
  const [core, prerelease = null] = value.split("-", 2);
  return { numbers: core.split(".").map(Number), prerelease };
}

/** Positive when left is newer. Supports the deliberately small Runner semver surface. */
export function compareRunnerVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return left === right ? 0 : -1;
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease == null) return 1;
  if (b.prerelease == null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function installedVersion(root: string): string {
  try {
    const value = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
    return VERSION_PATTERN.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function replaceSymlink(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const temporary = `${link}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.symlinkSync(target, temporary);
    fs.renameSync(temporary, link);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function fetchResponse(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`下载 Runner 失败：HTTP ${response.status}`);
  return response;
}

function assertArchiveEntries(entries: string): void {
  const paths = entries.split("\n").map((item) => item.trim()).filter(Boolean);
  if (!paths.length || paths.some((item) =>
    item.startsWith("/") || item.split("/").includes("..")
      || (item !== "alignyard-runner" && !item.startsWith("alignyard-runner/")))) {
    throw new Error("Runner 制品包含无效路径");
  }
}

export async function upgradeRunner(
  config: RunnerConfig,
  options: UpgradeRunnerOptions = {},
): Promise<UpgradeRunnerResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Runner 自动升级目前仅支持 macOS");
  const arch = releaseArch(options.arch ?? process.arch);
  const currentRoot = options.currentRoot || (() => {
    const command = process.env.ALIGNYARD_RUNNER_BIN?.trim();
    if (!command) throw new Error("请使用已安装的 ~/.local/bin/alignyard-runner 执行升级");
    return path.dirname(path.dirname(fs.realpathSync(command)));
  })();
  const from = installedVersion(currentRoot);
  const base = `${config.platform_url.replace(/\/$/, "")}/downloads/runner/stable/darwin-${arch}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestResponse = await fetchResponse(fetchImpl, `${base}/manifest.json`);
  const manifest = parseRunnerReleaseManifest(await manifestResponse.json(), arch);
  if (from !== "unknown" && compareRunnerVersions(manifest.version, from) <= 0) {
    return { updated: false, from, to: manifest.version, install_root: currentRoot };
  }

  const home = options.home ?? os.homedir();
  const appRoot = path.join(home, ".alignyard", "app");
  const target = path.join(appRoot, manifest.version);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "alignyard-runner-upgrade."));
  const stage = path.join(appRoot, `.${manifest.version}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const artifactResponse = await fetchResponse(fetchImpl, `${base}/alignyard-runner.tar.gz`);
    const artifact = Buffer.from(await artifactResponse.arrayBuffer());
    if (artifact.length !== manifest.size) throw new Error("Runner 制品大小与发布清单不一致");
    const digest = crypto.createHash("sha256").update(artifact).digest("hex");
    if (digest !== manifest.sha256) throw new Error("Runner 制品校验失败");
    const archive = path.join(temporary, "alignyard-runner.tar.gz");
    fs.writeFileSync(archive, artifact);
    const listed = await pexec("tar", ["-tzf", archive]);
    assertArchiveEntries(listed.stdout);
    await pexec("tar", ["-xzf", archive, "-C", temporary]);
    const packageRoot = path.join(temporary, "alignyard-runner");
    if (installedVersion(packageRoot) !== manifest.version) throw new Error("Runner 制品版本与发布清单不一致");

    fs.mkdirSync(appRoot, { recursive: true });
    fs.cpSync(packageRoot, stage, { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(stage, target);
    replaceSymlink(path.join(target, "bin", "alignyard-runner"), path.join(home, ".local", "bin", "alignyard-runner"));
    replaceSymlink(path.join(target, "bin", "ay"), path.join(home, ".local", "bin", "ay"));
    return { updated: true, from, to: manifest.version, install_root: target };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

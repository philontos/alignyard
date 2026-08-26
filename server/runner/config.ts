import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunnerConfig {
  platform_url: string;
  runner_id: string;
  token: string;
  name: string;
}

export function runnerConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ALIGNYARD_RUNNER_CONFIG?.trim() || path.join(os.homedir(), ".alignyard", "runner.json");
}

export function readRunnerConfig(target = runnerConfigPath()): RunnerConfig | null {
  try {
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!value || typeof value !== "object") return null;
    for (const key of ["platform_url", "runner_id", "token", "name"] as const) {
      if (typeof value[key] !== "string" || !value[key].trim()) return null;
    }
    return value as RunnerConfig;
  } catch {
    return null;
  }
}

export function writeRunnerConfig(config: RunnerConfig, target = runnerConfigPath()): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function normalizePlatformUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Platform URL 必须使用 http 或 https");
  }
  const localHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol === "http:" && !localHttpHosts.has(url.hostname.toLowerCase())) {
    throw new Error("非本机 Platform 必须使用 https");
  }
  if (url.username || url.password) throw new Error("Platform URL 不能包含用户名或密码");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function runnerWebSocketUrl(platformUrl: string): string {
  const url = new URL(normalizePlatformUrl(platformUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/runner`;
  return url.toString();
}

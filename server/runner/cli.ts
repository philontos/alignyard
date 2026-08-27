import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runnerCapabilities } from "./capabilities.js";
import {
  normalizePlatformUrl,
  readRunnerConfig,
  runnerConfigPath,
  writeRunnerConfig,
  type RunnerConfig,
} from "./config.js";
import { RunnerClient } from "./client.js";
import { upgradeRunner } from "./upgrade.js";
import { runnerVersion } from "./version.js";

const pexec = promisify(execFile);

function flags(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    result[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1");
  }
  return result;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLaunchAgent(command: string, home: string): string {
  const logDir = path.join(home, ".alignyard", "logs");
  const argumentsXml = `<string>start</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.alignyard.runner</string>
  <key>ProgramArguments</key>
  <array><string>${xml(command)}</string>${argumentsXml}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, "runner.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, "runner-error.log"))}</string>
</dict>
</plist>
`;
}

async function pairRunner(input: Record<string, string>): Promise<RunnerConfig> {
  const platformUrl = normalizePlatformUrl(input.platform || "");
  const code = String(input.code || "").trim();
  if (!code) throw new Error("缺少 --code <配对码>");
  const name = input.name || os.hostname();
  const response = await fetch(`${platformUrl}/api/runner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, os: process.platform, arch: process.arch }),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `配对失败：HTTP ${response.status}`);
  const config: RunnerConfig = {
    platform_url: platformUrl,
    runner_id: body.runner.id,
    token: body.token,
    name: body.runner.name,
  };
  writeRunnerConfig(config);
  return config;
}

async function installLaunchAgent(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("首版 Runner 自动安装仅支持 macOS");
  const home = os.homedir();
  // Launch through the stable symlink so changing a release never leaves the
  // background service pinned to its old version-specific directory.
  const command = path.join(home, ".local", "bin", "alignyard-runner");
  if (!fs.existsSync(command)) throw new Error(`找不到 Alignyard Runner 启动器：${command}`);
  const target = path.join(home, "Library", "LaunchAgents", "com.alignyard.runner.plist");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(home, ".alignyard", "logs"), { recursive: true });
  fs.writeFileSync(target, renderLaunchAgent(command, home));
  const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  await pexec("launchctl", ["bootout", domain, target]).catch(() => {});
  await pexec("launchctl", ["bootstrap", domain, target]);
  await pexec("launchctl", ["kickstart", "-k", `${domain}/com.alignyard.runner`]);
  return target;
}

function help(): string {
  return `Alignyard Runner

Usage:
  alignyard-runner pair --platform <url> --code <code> [--name <name>]
  alignyard-runner install --platform <url> --code <code> [--name <name>]
  alignyard-runner start
  alignyard-runner status
  alignyard-runner doctor
  alignyard-runner upgrade
`;
}

export async function runRunnerCli(argv: string[], out = console.log, err = console.error): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === "help" || command === "--help") {
      out(help());
      return 0;
    }
    if (command === "pair" || command === "install") {
      const config = await pairRunner(flags(rest));
      out(`Runner 已绑定：${config.name} (${config.runner_id})`);
      out(`配置：${runnerConfigPath()}`);
      if (command === "install") out(`LaunchAgent：${await installLaunchAgent()}`);
      return 0;
    }
    if (command === "service-install") {
      if (!readRunnerConfig()) throw new Error(`Runner 尚未配对；配置路径 ${runnerConfigPath()}`);
      out(`LaunchAgent：${await installLaunchAgent()}`);
      return 0;
    }
    if (command === "doctor") {
      out(JSON.stringify(await runnerCapabilities(), null, 2));
      return 0;
    }
    const config = readRunnerConfig();
    if (!config) throw new Error(`Runner 尚未配对；请先运行 alignyard-runner pair（配置路径 ${runnerConfigPath()}）`);
    if (command === "status") {
      out(JSON.stringify({
        configured: true,
        version: runnerVersion(),
        runner_id: config.runner_id,
        name: config.name,
        platform_url: config.platform_url,
      }, null, 2));
      return 0;
    }
    if (command === "upgrade") {
      const result = await upgradeRunner(config);
      if (!result.updated) {
        out(`Runner 已是最新版本：${result.to}`);
        return 0;
      }
      out(`Runner 已升级：${result.from} → ${result.to}`);
      out(`LaunchAgent：${await installLaunchAgent()}`);
      out("旧版本已保留在 ~/.alignyard/app，可用于手动回退。");
      return 0;
    }
    if (command === "start") {
      const client = new RunnerClient(config);
      const stop = () => client.stop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await client.run();
      return 0;
    }
    err(help());
    return 1;
  } catch (error: any) {
    err(String(error?.message || error));
    return 1;
  }
}

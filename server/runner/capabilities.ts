import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerCapabilities } from "./protocol.js";

const pexec = promisify(execFile);

async function available(command: string): Promise<boolean> {
  try {
    await pexec("sh", ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "alignyard-doctor", command], {
      env: process.env,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function runnerCapabilities(): Promise<RunnerCapabilities> {
  const [git, tmux, ssh, codex, claude, kimi, gh, glab] = await Promise.all(
    ["git", "tmux", "ssh", "codex", "claude", "kimi", "gh", "glab"].map(available),
  );
  return {
    git,
    tmux,
    ssh,
    agents: { codex, claude, kimi },
    forge: { gh, glab },
  };
}

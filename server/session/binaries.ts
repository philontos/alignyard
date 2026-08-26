import fs from "node:fs";

function resolveBinary(name: string, candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) || name;
}

// node-pty's spawn helper does not reliably honor a mutated PATH on macOS, so
// terminal transports resolve the common absolute locations once at startup.
export const TMUX_BIN = resolveBinary("tmux", [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
]);
export const SSH_BIN = resolveBinary("ssh", [
  "/usr/bin/ssh",
  "/opt/homebrew/bin/ssh",
]);
export const MOSH_BIN = resolveBinary("mosh", [
  "/opt/homebrew/bin/mosh",
  "/usr/local/bin/mosh",
  "/usr/bin/mosh",
]);

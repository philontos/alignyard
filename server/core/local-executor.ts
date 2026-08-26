import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "./paths.js";
import type { CommandRunner, ExecOpts } from "./command-runner.js";

const pexec = promisify(execFile);

/** Filesystem and process primitives available only inside the macOS Runner. */
export interface LocalExecutor extends CommandRunner {
  kind: "local";
  dataDir: string;
  mkdirp(dir: string): Promise<void>;
  exists(target: string): Promise<boolean>;
  readText(target: string): Promise<string | null>;
  rmrf(target: string): Promise<void>;
  putDir(source: string, target: string): Promise<void>;
  putFile(source: string, target: string): Promise<void>;
}

export class NodeLocalExecutor implements LocalExecutor {
  readonly kind = "local" as const;
  readonly dataDir = DATA_DIR;

  async exec(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
    const { stdout } = await pexec(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 64,
    });
    return stdout;
  }
  async mkdirp(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  async exists(target: string) { return fs.existsSync(target); }
  async readText(target: string) { try { return fs.readFileSync(target, "utf8"); } catch { return null; } }
  async rmrf(target: string) { fs.rmSync(target, { recursive: true, force: true }); }
  async putDir(source: string, target: string) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  async putFile(source: string, target: string) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

export const localExecutor = new NodeLocalExecutor();

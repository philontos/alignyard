/** Minimal process transport shared by the local execution kernel. It carries
 * no Host, SSH, Platform, or product-level behavior. */
export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export interface CommandRunner {
  kind: "local" | "ssh";
  exec(file: string, args: string[], opts?: ExecOpts): Promise<string>;
}

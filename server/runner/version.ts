import fs from "node:fs";

let cachedVersion: string | null = null;

/** The version shared by the source checkout and the self-contained Runner artifact. */
export function runnerVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const value = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    cachedVersion = typeof value?.version === "string" && value.version.trim()
      ? value.version.trim()
      : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion || "unknown";
}

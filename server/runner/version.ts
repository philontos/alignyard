import fs from "node:fs";

let cachedVersion: string | null = null;

/** Runner releases are versioned independently so Platform dependency layers stay cacheable. */
export function runnerVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = fs.readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim() || "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion || "unknown";
}

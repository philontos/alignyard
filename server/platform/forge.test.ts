import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../fleet/runner.ts";
import { repositoryForgeKind, resolveForge } from "./forge.ts";

test("forge detection recognizes HTTPS, SSH, and branded self-hosted URLs", () => {
  assert.equal(repositoryForgeKind("git@github.com:team/service.git"), "github");
  assert.equal(repositoryForgeKind("https://gitlab.com/team/service.git"), "gitlab");
  assert.equal(repositoryForgeKind("ssh://git@code.gitlab.corp/team/service.git"), "gitlab");
  assert.equal(repositoryForgeKind("git@code.example.com:team/service.git"), "unknown");
});

test("an ambiguous self-hosted URL is resolved through the authenticated local CLI", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = {
    kind: "local",
    async exec(file, args) {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "glab") return JSON.stringify({ web_url: "https://code.example.com/team/service" });
      throw new Error("unexpected command");
    },
  };
  assert.equal(await resolveForge({ runner, cwd: "/worktree", gitUrl: "git@code.example.com:team/service.git" }), "gitlab");
  assert.deepEqual(calls, ["glab repo view --output json"]);
});

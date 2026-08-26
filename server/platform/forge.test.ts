import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandRunner } from "../core/command-runner.ts";
import { closeChangeRequest, repositoryForgeKind, resolveForge } from "./forge.ts";

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

test("closing a GitHub PR uses the local CLI and removes its branch", async () => {
  const calls: string[] = [];
  let state = "OPEN";
  const runner: CommandRunner = {
    kind: "local",
    async exec(file, args) {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "gh" && args[1] === "view") {
        return JSON.stringify({ number: 42, url: "https://github.com/example/service/pull/42", state });
      }
      if (file === "gh" && args[1] === "close") {
        state = "CLOSED";
        return "";
      }
      throw new Error("unexpected command");
    },
  };

  const closed = await closeChangeRequest("github", {
    runner, cwd: "/worktree", gitUrl: "git@github.com:example/service.git",
    baseBranch: "main", headBranch: "change/ay-001/phil",
  }, 42);

  assert.equal(closed.state, "closed");
  assert.ok(calls.includes("gh pr close 42 --delete-branch"));
});

test("closing a GitLab MR removes its source branch with local Git", async () => {
  const calls: string[] = [];
  let state = "opened";
  const runner: CommandRunner = {
    kind: "local",
    async exec(file, args) {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "glab" && args[1] === "view") {
        return JSON.stringify({ iid: 42, web_url: "https://gitlab.com/example/service/-/merge_requests/42", state });
      }
      if (file === "glab" && args[1] === "close") {
        state = "closed";
        return "";
      }
      if (file === "git" && args[0] === "push") return "";
      throw new Error("unexpected command");
    },
  };

  const closed = await closeChangeRequest("gitlab", {
    runner, cwd: "/worktree", gitUrl: "git@gitlab.com:example/service.git",
    baseBranch: "main", headBranch: "change/ay-001/phil",
  }, 42);

  assert.equal(closed.state, "closed");
  assert.ok(calls.includes("glab mr close 42"));
  assert.ok(calls.includes("git push origin --delete change/ay-001/phil"));
});

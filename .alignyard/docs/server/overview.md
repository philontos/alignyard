---
id: doc.server.overview
title: "Server Overview"
kind: doc
scope: server
owners: []
relations: []
---

# Overview

## Responsibilities

`server/` is a TypeScript backend and command-line application organized as one deployable Node.js process. Its main composition root, `server/index.ts`, creates the Express app and HTTP servers, attaches the WebSocket terminal bridge, reconciles local manifests/worktrees, starts fleet liveness checks, restores the keep-awake state, and then listens on every requested address.

`server/http/app.ts` serves `web/platform.html` at `/`, exposes a narrow local path for the installed Highlight.js assets, serves the remaining `web/` files statically, and registers the API routes. `server/http/ws.ts` owns the terminal WebSocket bridge; `server/http/routes.ts` is the REST integration layer over the domain modules.

## Command-line entry points

- `server/tdsp.ts` wires the operational `tdsp` CLI to repository, task, tmux/PTY, provider, fleet, networking, transcript, and lifecycle services. The decision logic is injected through `server/task/cli.ts`.
- `server/ay.ts` is the thin entry point for the Alignyard knowledge CLI in `server/protocol/cli.ts`. Its supported workflow is `init`, `new`, `validate`, and `sync`.
- Both runtime entry points add common Homebrew and `/usr/local` binary directories to child-process `PATH`, because Git, tmux, agents, SSH, and related commands are launched outside the Node process.

## Domain modules

- `core/`: data paths, SQLite access/schema/migrations, ownership checks, process lifecycle, and i18n.
- `repo/`: local repository catalog, Git mirrors, task/reference worktrees, manifests, and repository environment construction.
- `task/`: task creation, references, lifecycle, paste support, task manifests, and CLI parsing.
- `session/`: agent launch arguments, tmux sessions, PTYs, hooks, attachments, and transcripts.
- `fleet/`: local/SSH runners, node bootstrap and uninstall, liveness, and remote node views.
- `network/` and `onboarding/`: Tailscale/private-network operations plus live connectivity, phone, power, and readiness checks.
- `provider/` and `codeview/`: provider configuration and bounded repository/worktree inspection.
- `protocol/`: the `.alignyard` manifest/document schema, generators, validator, indexer, and sync client.
- `platform/`: Alignyard repositories, Tasks, artifact snapshots, protocol-state refresh, and the repository-initialization review/PR workflow.

The platform sync endpoint accepts only an editable Task repository, validates document metadata/content hashes and manifest scopes, and stores the submitted snapshot in SQLite. `ay validate` remains the structural authority before sync. Repository initialization requires the shared overview; later push, PR, and merge actions belong to the explicit platform review workflow rather than the knowledge CLI.

## State and execution model

Persistent application state is node-local SQLite via `better-sqlite3`. Git worktrees and tmux sessions persist task execution outside the browser; `node-pty` bridges interactive terminals. Remote node operations run through SSH, and Tailscale is an optional system integration rather than an npm dependency.

The backend is tested with Node's built-in test runner. Tests sit beside domain modules as `*.test.ts`; the repository-wide command is `npm test`. There is no separate production compilation script in `package.json`: development and start commands execute TypeScript through `tsx`.

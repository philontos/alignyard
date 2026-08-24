---
id: doc.shared.overview
title: "Repository Overview"
kind: doc
scope: shared
owners: []
relations: []
---

# Overview

## Repository identity

This is a private Node.js ESM package named `task-dispatcher`. The root README presents the user-facing product as Switchyard: a local-first control plane that gives AI coding tasks isolated Git worktrees and persistent tmux sessions, with browser access from a development machine or phone. The same source tree also contains the Alignyard repository/task catalog, versioned knowledge protocol, and repository-initialization workflow.

The names are not interchangeable in the checked-in metadata: use `task-dispatcher` for the npm package, `Switchyard` for the control-plane behavior described by the README, and `Alignyard` for `.alignyard` knowledge and the platform Task workflow.

## Technology and layout

- `server/` is the TypeScript backend and CLI scope. It owns local persistence, repository and task lifecycle, agent sessions, fleet/network integration, HTTP/WebSocket transport, and the Alignyard protocol/platform implementation.
- `web/` is the browser UI scope. It contains static HTML, CSS, assets, vendored xterm files, and native JavaScript modules; there is no separate frontend build step in `package.json`.
- `scripts/setup.sh` performs installation/preflight work, while `scripts/readme-demo/` drives deterministic README screenshots against a disposable mock server.
- `docs/screenshots/` contains the generated, sanitized README images rather than engineering design documents.

Runtime dependencies include Express, WebSocket support, `better-sqlite3`, `node-pty`, YAML parsing, QR generation, and a pinned local Highlight.js bundle. TypeScript targets ES2022 with strict checking and includes `server/**/*.ts`.

## Entry points and commands

- `npm run dev` watches `server/index.ts`; `npm start` runs it once.
- `npm run tdsp -- <command>` enters the operational CLI through `server/tdsp.ts`.
- `npm run ay -- <command>` enters the Alignyard knowledge CLI through `server/ay.ts`.
- `npm test` runs the Node test runner over `server/**/*.test.ts` and `web/**/*.test.mjs` with `tsx` enabled for TypeScript.
- `npm run screenshots:readme` refreshes the checked-in product screenshots. It requires Chrome, optionally selected with `CHROME_BIN`.

Installation and runtime requirements documented by the repository are Node.js 22+, Git, tmux, and zsh. The setup script currently preflights both `claude` and `kimi`; `codex` is optional and must be checked separately when it will be used.

## Runtime boundaries

The server listens on `127.0.0.1:4500` by default. It can expose selected private addresses or use Tailscale Serve, but the web terminal is equivalent to shell access and the application does not provide application-level multi-user authentication. Repository tokens and provider keys are stored in the node-local SQLite database, so deployments are intended for personal, trusted machines and private network paths.

Each Switchyard node remains authoritative for its own repositories, worktrees, tmux sessions, agents, and persistent state. Cross-machine control uses Switchyard on the target node rather than transferring ownership to a central service.

## Alignyard knowledge

`.alignyard/repository.yaml` routes durable knowledge into the `shared`, `server`, and `web` scopes. Docs record verified current behavior. This baseline contains no Specs because it does not introduce an intended product change, and no ADRs because the repository does not provide an explicit decision record with alternatives and consequences.

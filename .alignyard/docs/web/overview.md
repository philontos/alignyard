---
id: doc.web.overview
title: "Web UI Overview"
kind: doc
scope: web
owners: []
relations: []
---

# Overview

## Delivery model and entry points

`web/` is a static browser application served directly by Express. It uses HTML, CSS, and native ES modules without a bundler or framework-specific build step.

The current server root (`/`) returns `web/platform.html`. Its module entry, `web/js/platform.js`, implements the Alignyard Repository and Task workspace: repository registration/protocol refresh, Task creation and filtering, synchronized knowledge artifact display, and the repository-initialization stages for Agent work, Review, PR, and merge.

The tree also contains `web/index.html` and `web/js/main.js`, the Switchyard task-board interface described by the root README. That entry composes repository/task/fleet controls, terminal and transcript views, code inspection, provider settings, onboarding, and mobile behavior. Because Express serves `web/` with automatic directory indexes disabled, this file is available as an explicit static asset but is not the `/` response.

## Module boundaries

- `web/js/core/` contains shared DOM/API helpers, state, dialogs, feedback, custom selects, task-state interpretation, host following, reading-target selection, and code/repository formatting helpers.
- `web/js/features/` contains task/repository/fleet views, terminal and transcript behavior, code and runtime-reference inspection, provider controls, onboarding, task ordering, and mobile navigation.
- `web/js/main.js` is the Switchyard composition point. It bridges selected module functions onto `window` for existing inline event handlers, initializes views, and starts data/liveness polling.
- `web/js/platform.js` is a self-contained composition point for the Alignyard platform page and calls `/api/platform/*` plus the local repository API.
- `web/i18n.js` and `web/theme.js` provide browser-global language/theme behavior used by the Switchyard page. `web/vendor/` carries the browser xterm runtime locally.
- `web/css/app.css` styles the Switchyard console; `web/css/platform.css` styles the Alignyard workspace.

## Backend contracts and testing

Browser data operations use JSON HTTP endpoints. Interactive terminals connect to `/pty` over a same-origin WebSocket and reconnect/resize through the terminal feature module. The browser loads the installed Highlight.js bundle from the backend's `/vendor/highlight` path on demand, so code preview does not require a public CDN.

Frontend tests are colocated as `*.test.mjs` and run under Node as part of `npm test`. They cover pure UI/state helpers and source-level interaction contracts, including task lifecycle, mobile navigation, terminal behavior, host following, code view, and repository details. README screenshots are a separate deterministic browser workflow under `scripts/readme-demo/`.

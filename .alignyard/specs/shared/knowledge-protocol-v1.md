---
id: spec.shared.knowledge-protocol-v1
title: Alignyard Knowledge Protocol v1
kind: spec
scope: shared
owners: []
relations:
  - doc.shared.overview
  - adr.shared.0001
---

# Context

Repositories need one predictable place where people, agents, scripts, and the platform can create and consume engineering knowledge without giving the platform Git credentials.

# Goals

- Define one versioned `.alignyard/` workspace per repository.
- Provide basic templates for docs, specs, and ADRs.
- Make initialization and document creation deterministic.
- Validate and synchronize a reviewable Task knowledge snapshot.
- Keep the platform thin: it consumes reported facts and content rather than owning a checkout.

# Non-goals

- Executable repository hooks or arbitrary validation plugins.
- A separate Knowledge product page.
- Automatic mutation of a repository's default branch.

# Design

`.alignyard/repository.yaml` declares protocol version, preset, and scopes. Knowledge is grouped under `.alignyard/docs`, `.alignyard/specs`, and `.alignyard/adrs`; each document has YAML frontmatter with a stable ID, kind, scope, title, and relations.

The `ay` command owns deterministic initialization, document creation, validation, and synchronization. The repository Skill guides agent behavior but cannot override the validator. Initialization is performed in a normal draft Task and reaches the default branch only through review and merge.

`ay sync` uploads only the manifest, normalized document metadata, Markdown content, hashes, and optional Git baseline information. It never uploads source files, worktrees, Git credentials, or environment values.

# Acceptance Criteria

- `ay init` creates the minimal protocol scaffold without overwriting existing files.
- `ay new` creates docs, specs, and ADRs from the repository templates with stable IDs and paths.
- `ay validate` accepts this repository and rejects invalid manifests, scopes, document kinds, required sections, duplicate IDs, and missing relations.
- `ay sync` refuses invalid knowledge and publishes a bounded Task snapshot to an associated editable Repository.
- Alignyard itself carries a valid protocol workspace and uses it for subsequent iteration.

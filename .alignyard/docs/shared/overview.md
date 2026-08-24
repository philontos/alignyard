---
id: doc.shared.overview
title: Alignyard overview
kind: doc
scope: shared
owners: []
relations:
  - spec.shared.knowledge-protocol-v1
---

# Overview

Alignyard is a thin collaboration surface over repositories and Tasks. Git credentials, worktrees, and agent sessions remain on the developer's machine; the platform shares repository locators, Task state, and reviewable engineering knowledge.

The first product surface contains only Repositories and Tasks. Repository knowledge lives in `.alignyard/` and is validated before a Task enters review.

---
id: adr.shared.0001
title: Centralize engineering knowledge under .alignyard
kind: adr
scope: shared
owners: []
relations:
  - spec.shared.knowledge-protocol-v1
---

# Context

Engineering knowledge can be scattered across root documentation, application folders, agent rules, and platform records. That makes discovery and consistent validation difficult.

# Decision

Alignyard Protocol v1 uses one repository-root `.alignyard/` directory as the canonical collaboration workspace. A single manifest declares logical scopes, while docs, specs, ADRs, templates, and agent guidance remain versioned together.

# Consequences

The platform and agents have a predictable read boundary, and content eligible for synchronization is explicit. Existing repositories may need an assisted migration Task, and raw Git browsing places engineering knowledge under a hidden directory rather than conventional top-level documentation paths.

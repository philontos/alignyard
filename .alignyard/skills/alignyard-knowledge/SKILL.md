---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's `.alignyard/repository.yaml` as the routing contract and `ay` as the structural authority. Treat `.alignyard/` as the source of truth for core engineering intent and architectural constraints, not as a mirror of the codebase. Keep only decision-relevant, evidence-based, reviewable knowledge.

## Choose the workflow

- **Repository bootstrap:** use when `.alignyard` was just initialized or the user asks to establish the initial knowledge framework.
- **Framework update:** use after `ay update` replaces Alignyard-managed framework files and asks for a semantic review of existing knowledge.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Repository bootstrap

### 1. Survey repository evidence

1. Inventory tracked source, root README files, package or workspace manifests, build/test/release commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Build an evidence map of the repository's system boundaries, main data flows, stable CLI/API/configuration surfaces, development and operating workflows, and repository-specific conventions. Distinguish verified facts from questions.
3. Define `shared` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set `source` only when one directory clearly owns that scope.

### 2. Plan a minimal, sufficient baseline

1. Always create the shared repository overview. Use it as a concise map and navigation entry, not as a catch-all document. For protocol v2, also complete the generated Constitution from verified repository constraints and user-confirmed intent; never leave it as a generic placeholder.
2. Cover only durable information that can change an Agent's design direction: product intent, architecture and dependency boundaries, stable public contracts, data/security/permission boundaries, explicit invariants, and important technical choices. Keep implementation details in code, types, tests, or local comments when they are directly recoverable there.
3. Use this test before creating or expanding a document: if a future Agent did not know this fact, could it produce a locally correct implementation that violates the intended system design? If not, omit it. Give a topic its own Doc only when it has enough verified substance and evolves independently.
4. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, an explicit durable decision belongs in ADRs, and a concrete optional implementation design belongs in a Plan. Do not infer an ADR merely from code shape. Bootstrap Specs and Plans are optional; empty or speculative Specs, ADRs, and Plans are prohibited.

### 3. Create and verify documents

1. Use `ay new` for every new document, then fill its body from repository evidence. Preserve original documents unless the Task explicitly includes migration or removal.
2. Keep documents focused and add meaningful `relations` when the overview or one topic depends on another document.
3. Run an intent-coverage review before validation: ensure core intent, architecture boundaries, stable contracts, invariants, and durable choices are covered, then remove details duplicated from code or tests.
4. Run `ay validate` and resolve every structural error. Passing validation proves protocol structure, not truth, sufficiency, or concision.
5. Run `ay validate`. Report evidence inspected, scopes and documents created, topics intentionally omitted with reasons, unresolved questions, and validation results.

## Framework update

1. Run `ay update --check` before applying an available update, then run `ay update`. Treat `.alignyard/README.md`, the default templates, and this Skill as Alignyard-managed framework files; keep repository-specific instructions in the Constitution or ordinary knowledge documents.
2. Preserve every existing Doc, Spec, ADR, Plan, stable document ID, scope, relation, source, and governing reference unless repository evidence or an explicit user decision requires a semantic change. The update command migrates structure; it does not rewrite knowledge content.
3. Read the updated Constitution and Overview, then review existing knowledge against the current framework. Remove code-recoverable detail and stale process narration; retain verified intent, boundaries, invariants, stable contracts, and durable decisions.
4. Ask the user before changing consequential intent or architecture. Run `ay validate`, commit the complete `.alignyard/` diff, and wait for human Review.

## Task work

1. Read the manifest entrypoints first, then route through the relevant scope Docs, active Specs, related ADRs, and existing Plans. Treat the accepted Spec as authoritative over external source links.
2. Decide which existing or new documents the change actually needs. A material new capability or boundary change normally needs a concise Spec; a small correction, documentation-only Task, or change already covered by an accepted Spec may only update existing Docs. Do not create a primary document merely to satisfy a workflow shape.
3. Ask the user directly when missing facts could change product intent, public interfaces, architecture boundaries, compatibility, or change scope. Do not invent a decision. Incorporate the confirmed answer into the final Spec, ADR, Plan, or Doc.
4. Create an ADR only for a durable decision with meaningful alternatives or consequences. Create a Plan only when a concrete implementation design materially reduces ambiguity; Plans are optional.
5. A Plan must govern itself with the Constitution and cite only the Docs, Specs, and ADRs that actually constrain the implementation. A Spec is typical for new behavior or boundary changes, but is not mandatory when existing knowledge already states the intent. State what may change and what must remain unchanged, and include implementation and validation steps. External sources are traceability references, not governing truth.
6. Draft target-state Docs at their normal paths on the Task branch. The branch is the proposal; do not create a temporary Docs copy. Reconcile Docs with the actual implementation before publishing them to the default branch.
7. Unless the Task explicitly requests implementation, stop after producing the reviewable knowledge package. Preserve stable document IDs and use `relations` only for meaningful dependencies.
8. Run `ay validate` after knowledge changes. Before requesting Review, commit all changes and make sure `git status --short` is empty; the Runner will repeat these checks and push the branch when the user submits Review.

## Document semantics

- **Docs:** current accepted system truth. Prefer concise overviews and operational facts that remain useful after the Task closes.
- **Specs:** the contract for an intended change: context, goals, non-goals, design, and acceptance criteria.
- **ADRs:** a durable decision and its consequences. Record why, not a chronological meeting transcript.
- **Plans:** an optional, executable technical design for one intended change. It bridges accepted knowledge to implementation without becoming current system truth.
- **Constitution:** the reserved `doc.shared.constitution` entrypoint. It records repository-wide intent, boundaries, confirmation rules, and enforceable constraints.

Keep every document concise and single-purpose. Record the intent, boundary, rationale, or invariant that must survive implementation; omit function-level mechanics, ordinary field plumbing, meeting transcripts, and implementation logs. Git commits, blame, PR/MR review, and Alignyard Review provide authorship and approval traceability; do not add document owners merely to duplicate that history.

## Safety and quality

- Write Docs, Specs, ADRs, and Plans in Simplified Chinese, including titles, headings, and prose. Keep code identifiers, commands, paths, API names, and established product names unchanged when translation would reduce precision. This Skill itself may remain in English.
- Do not invent behavior, ownership, commands, or decisions. Ask the user in the current Agent conversation when a consequential fact or decision is uncertain.
- Do not read or reproduce secret values. Refer to environment-variable names only when relevant.
- Do not edit source paths outside the Task's scope merely to make documentation appear complete.
- Treat `ay validate` as authoritative for structure; use repository evidence and user decisions for substance.

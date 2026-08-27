---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's `.alignyard/repository.yaml` as the routing contract and `ay` as the structural authority. Treat `.alignyard/` as the source of truth for core engineering intent and architectural constraints, not as a mirror of the codebase. Keep only decision-relevant, evidence-based, reviewable knowledge.

## Choose the workflow

- **Repository bootstrap:** use when `.alignyard` was just initialized or the user asks to establish the initial knowledge framework.
- **Framework update:** use to upgrade Alignyard-managed files and protocol structure while preserving repository knowledge content.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Responsibility boundaries

- Put repository-specific product intent, current architecture, stable contracts, non-obvious business semantics, and durable invariants in `.alignyard/` when an Agent could otherwise make a locally reasonable but systemically wrong decision.
- Keep function mechanics, ordinary field plumbing, executable behavior, and implementation truth in code, types, tests, and runtime behavior.
- Keep Agent operating instructions, tools, hooks, build/test commands, and mechanical enforcement in the repository's Agent Harness, `AGENTS.md`, or equivalent workflow layer. That layer may route to Alignyard entrypoints or document IDs, but must not copy or redefine repository knowledge as a second source of truth.
- Do not snapshot changing runtime data into long-lived knowledge. Record a durable source, interpretation, lifecycle, or fallback policy only when it constrains design.

## Semantic alignment across boundaries

Apply this review whenever a Task combines, transfers, compares, or reinterprets a business concept across module, service, repository, API, storage, or organizational boundaries.

1. Identify the affected business concepts and every boundary they cross. Separate the authoritative meaning of each concept from its representation at each boundary.
2. Classify source and target semantics as equivalent, different, or unknown. Matching field names, primitive types, or product shorthand are not evidence of equivalence.
3. When representations differ, define the normalization or mapping rule and representative boundary examples before implementation. When meaning is unknown, establish it from repository evidence or ask the user; do not silently choose an interpretation.
4. Store the current semantic invariant and boundary contract in Docs, the intended change and examples in a Spec, the reason for a durable choice in an ADR, and optional implementation detail in a Plan. Put executable mappings and regression checks in code/tests or the Harness; do not duplicate them as prose.

## Repository bootstrap

### 1. Survey repository evidence

1. Inventory tracked source, root README files, package or workspace manifests, build/test/release commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Build an evidence map of the repository's system boundaries, main data flows, stable CLI/API/configuration surfaces, development and operating workflows, repository-specific conventions, and non-obvious data semantics at boundaries. Distinguish verified facts from questions.
3. Define `shared` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set `source` only when one directory clearly owns that scope.

### 2. Plan a minimal, sufficient baseline

1. Always create the shared repository overview. Use it as a concise map and navigation entry, not as a catch-all document. For protocol v2, also complete the generated Constitution from verified repository constraints and user-confirmed intent; never leave it as a generic placeholder.
2. Cover only durable information that can change an Agent's design direction: product intent, architecture and dependency boundaries, stable public contracts, data/security/permission boundaries, explicit invariants, important technical choices, and non-obvious semantic differences for the same business concept across boundaries. Keep implementation details in code, types, tests, or local comments when they are directly recoverable there.
3. Use this test before creating or expanding a document: if a future Agent did not know this fact, could it produce a locally correct implementation that violates the intended system design? If not, omit it. Give a topic its own Doc only when it has enough verified substance and evolves independently.
4. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, an explicit durable decision belongs in ADRs, and a concrete optional implementation design belongs in a Plan. Do not infer an ADR merely from code shape. Bootstrap Specs and Plans are optional; empty or speculative Specs, ADRs, and Plans are prohibited.

### 3. Create and verify documents

1. Use `ay new` for every new document, then fill its body from repository evidence. Preserve original documents unless the Task explicitly includes migration or removal.
2. Keep documents focused and add meaningful `relations` when the overview or one topic depends on another document.
3. Run an intent-coverage review before validation: ensure core intent, architecture boundaries, stable contracts, invariants, durable choices, and relevant cross-boundary data semantics are covered, then remove details duplicated from code or tests.
4. Run `ay validate` and resolve every structural error. Passing validation proves protocol structure, not truth, sufficiency, or concision.
5. Run `ay validate`. Report evidence inspected, scopes and documents created, topics intentionally omitted with reasons, unresolved questions, and validation results.

## Framework update

1. Run `ay update --check` first. Record the before/after protocol and framework versions and classify every planned path as a managed-file replacement, manifest merge, or missing fixed structure. Stop and ask the user if an existing knowledge document would be overwritten or a change does not fit those categories.
2. Run `ay update`, read the updated Skill, and inspect the actual `.alignyard/` Git diff. Treat the update as a framework migration, not a semantic knowledge review. Preserve every existing Doc, Spec, ADR, Plan, knowledge body, stable document ID, scope, relation, source, and governing reference by default.
3. Change repository knowledge content only when protocol compatibility explicitly requires it or the user explicitly asks for it. Keep the change minimal and ask before changing consequential product intent, public contracts, architecture boundaries, or compatibility. Perform optional cleanup through ordinary Task work, not opportunistically during an update.
4. Run `ay validate`, then run `ay update --check` again and require no pending changes. Confirm all changes are under `.alignyard/`, commit them, ensure `git status --short` is empty, summarize the actual migration and any justified semantic change, and wait for human Review.

## Task work

1. Read the manifest entrypoints first, then route through the relevant scope Docs, active Specs, related ADRs, and existing Plans. Treat the accepted Spec as authoritative over external source links.
2. Map the affected business concepts and boundaries. For each affected boundary, route through its scope Docs and relations. When a concept is combined, transferred, compared, or reinterpreted, establish the authoritative meaning, each representation, their compatibility, and any required mapping before proposing a design. If existing knowledge is insufficient, inspect repository evidence and then ask the user when the meaning remains uncertain.
3. Decide which existing or new documents the change actually needs. A material new capability or boundary change normally needs a concise Spec; a small correction, documentation-only Task, or change already covered by an accepted Spec may only update existing Docs. Do not create a primary document merely to satisfy a workflow shape.
4. Ask the user directly when missing facts could change product intent, public interfaces, architecture boundaries, compatibility, change scope, or the meaning of a concept across boundaries. Do not invent a decision. Incorporate the confirmed answer into the final Spec, ADR, Plan, or Doc.
5. Create an ADR only for a durable decision with meaningful alternatives or consequences. Create a Plan only when a concrete implementation design materially reduces ambiguity; Plans are optional.
6. Use `governing` on a Spec or Plan to cite only the Docs and ADRs that actually define its affected concepts, boundaries, and constraints. A Plan must also govern itself with the Constitution and may cite its accepted Spec. A Spec is typical for new behavior or boundary changes, but is not mandatory when existing knowledge already states the intent. State what may change and what must remain unchanged, and include implementation and validation steps. External sources are traceability references, not governing truth.
7. Draft target-state Docs at their normal paths on the Task branch. The branch is the proposal; do not create a temporary Docs copy. Reconcile Docs with the actual implementation before publishing them to the default branch.
8. Unless the Task explicitly requests implementation, stop after producing the reviewable knowledge package. Preserve stable document IDs and use `relations` only for meaningful dependencies.
9. Run `ay validate` after knowledge changes. Before requesting Review, commit all changes and make sure `git status --short` is empty; the Runner will repeat these checks and push the branch when the user submits Review. When cross-boundary semantic alignment applied, summarize the confirmed concepts, representations, mappings, examples, and unresolved non-blocking risks for the Reviewer.

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

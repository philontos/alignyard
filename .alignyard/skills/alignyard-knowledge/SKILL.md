---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's `.alignyard/repository.yaml` as the routing contract and `ay` as the structural authority. Keep the knowledge set small, evidence-based, and reviewable.

## Choose the workflow

- **Repository bootstrap:** use when `.alignyard` was just initialized or the user asks to establish the initial knowledge framework.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Repository bootstrap

1. Inventory tracked source, root README files, package or workspace manifests, build commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Define `shared` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set `source` only when one directory clearly owns that scope.
3. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, and an explicit durable decision belongs in ADRs. Do not infer an ADR merely from code shape.
4. Create the smallest useful baseline: one shared repository overview and one overview for each meaningful scope. Add development or architecture Docs only when the repository provides evidence. A bootstrap Spec is optional; empty or speculative ADRs are prohibited.
5. Use `ay new` for every new document, then fill its body. Preserve original documents unless the Task explicitly includes migration or removal.
6. Run `ay validate`, resolve every structural error, then run `ay sync`. Report created scopes and documents plus any unresolved questions.

## Task work

1. Read the manifest, then the relevant scope Docs, active Specs, and related ADRs before proposing changes.
2. Use a Spec for a material intended change once goals and boundaries are clear. Keep transient conversation and implementation logs out of long-lived knowledge.
3. Update Docs when accepted current behavior changes. Create an ADR only for a durable decision with meaningful alternatives or consequences.
4. Preserve stable document IDs. Use `relations` for meaningful dependencies; do not create decorative links.
5. Run `ay validate` after knowledge changes and `ay sync` before handing the Task back or requesting review.

## Document semantics

- **Docs:** current accepted system truth. Prefer concise overviews and operational facts that remain useful after the Task closes.
- **Specs:** the contract for an intended change: context, goals, non-goals, design, and acceptance criteria.
- **ADRs:** a durable decision and its consequences. Record why, not a chronological meeting transcript.

## Safety and quality

- Do not invent behavior, ownership, commands, or decisions. Mark uncertain facts for confirmation.
- Do not read or reproduce secret values. Refer to environment-variable names only when relevant.
- Do not edit source paths outside the Task's scope merely to make documentation appear complete.
- Treat `ay validate` as authoritative for structure; use repository evidence and user decisions for substance.

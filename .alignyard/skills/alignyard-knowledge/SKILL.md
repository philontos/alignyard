---
name: alignyard-knowledge
description: Bootstrap or maintain repository engineering knowledge under .alignyard when an Alignyard Task requires Docs, Specs, ADRs, scope routing, or knowledge validation.
---

# Alignyard Knowledge

Use this repository's `.alignyard/repository.yaml` as the routing contract and `ay` as the structural authority. Keep the knowledge set small but complete, evidence-based, and reviewable.

## Choose the workflow

- **Repository bootstrap:** use when `.alignyard` was just initialized or the user asks to establish the initial knowledge framework.
- **Task work:** use for ordinary requirement discussion, implementation, or documentation changes in an initialized repository.

## Repository bootstrap

### 1. Survey repository evidence

1. Inventory tracked source, root README files, package or workspace manifests, build/test/release commands, CI, existing docs, and the main application entry points. Ignore dependencies, generated output, large binaries, and secrets.
2. Build an evidence map of the repository's system boundaries, main data flows, stable CLI/API/configuration surfaces, development and operating workflows, and repository-specific conventions. Distinguish verified facts from questions.
3. Define `shared` plus only the meaningful application or service boundaries as scopes. Do not mirror every directory or package into a scope. Set `source` only when one directory clearly owns that scope.

### 2. Plan a small but complete baseline

1. Always create the shared repository overview. Use it as a concise map and navigation entry, not as a catch-all document.
2. Evaluate every applicable durable topic: architecture and boundaries; local development, build, test, release, and operations; stable CLI/API/configuration contracts; repository-specific protocols, directory conventions, and maintenance workflows; and an overview for each meaningful non-shared scope.
3. Give a topic its own Doc when it has enough verified substance and will evolve independently. Merge truly small topics into the overview instead of creating empty files. A repository with several stable commands or a repository-specific protocol normally needs a dedicated Doc for that surface.
4. Classify existing knowledge: current verified behavior belongs in Docs, an intended but unfinished change belongs in Specs, and an explicit durable decision belongs in ADRs. Do not infer an ADR merely from code shape. Bootstrap Specs are optional; empty or speculative Specs and ADRs are prohibited.

### 3. Create and verify documents

1. Use `ay new` for every new document, then fill its body from repository evidence. Preserve original documents unless the Task explicitly includes migration or removal.
2. Keep documents focused and add meaningful `relations` when the overview or one topic depends on another document.
3. Run a content-completeness review before validation: every meaningful scope and every applicable durable topic must point to a Doc, be intentionally covered by the overview, or have an explicit evidence-based reason for omission.
4. Run `ay validate` and resolve every structural error. Passing validation proves protocol structure, not content completeness; do not stop merely because it passes.
5. Run `ay sync`. Report evidence inspected, scopes and documents created, topics intentionally omitted with reasons, unresolved questions, and validation results.

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

- Write Docs, Specs, and ADRs in Simplified Chinese, including titles, headings, and prose. Keep code identifiers, commands, paths, API names, and established product names unchanged when translation would reduce precision. This Skill itself may remain in English.
- Do not invent behavior, ownership, commands, or decisions. Mark uncertain facts for confirmation.
- Do not read or reproduce secret values. Refer to environment-variable names only when relevant.
- Do not edit source paths outside the Task's scope merely to make documentation appear complete.
- Treat `ay validate` as authoritative for structure; use repository evidence and user decisions for substance.

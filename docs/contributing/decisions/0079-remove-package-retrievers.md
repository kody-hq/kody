# 0079: Remove package retrievers

- **Status:** accepted
- **Date:** 2026-10-24

## Context

Package retrievers ran package exports on every search or context-enrichment
call in a closed-world sandbox. This added latency to the common search path for
a feature with essentially one real user package, `@kentcdodds/skills`; its
retriever declaration was removed before this change.

## Decision

Remove package retrievers and their search/context runtime. Authoring manifests
reject `kody.retrievers`, while published snapshots ignore the retired field.
Agents can call package exports from `execute`, for example
`kody:@kentcdodds/skills/skill-search`.

## Consequences

Search and context enrichment no longer run package code implicitly, and package
exports remain available through explicit execution. Historical published
snapshots continue to load without activating the removed feature. Revisit if a
concrete need emerges that cannot be served by explicit package execution
without putting work on every search.

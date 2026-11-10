# 0100: Declare lifecycle graphs once, not as scattered status checks

- **Status:** superseded by [0101](./0101-xstate-lifecycles.md)
- **Date:** 2026-11-09

## Context

Status unions, SQL guards, runtime parsing and agent documentation can describe
different lifecycles. Rollback edges are especially easy to omit from a list of
otherwise linear states.

## Decision

Every lifecycle/status column and multi-step UI flow must have an explicit
`defineStateMachine` graph in a dependency-light module next to its domain.
Migrate existing flows incrementally without changing stored values, API
contracts or SQL semantics. Export existing type names as `StateOf` aliases.
Derive runtime membership from the graph. Declare SQL transition guards with
`machine.guard({ from, to })`, which validates every source-to-target pair and
returns the explicit source states as a SQL literal list. Hoist fixed guards to
module-level constants and preserve operation-specific sources rather than
broadening an atomic write to every incoming edge. Do not add validation throws
to existing reads unless they already validate or a DB CHECK guarantees the set.

Register every machine and regenerate the
[state-machine reference](../state-machines.md). Tests enforce registration and
pin each migrated graph. Do not introduce a state-machine runtime dependency or
put database access, side effects or application orchestration in the shared
primitive.

## Consequences

Agents and contributors can discover legal transitions without reconstructing
them from handlers. Definition validation fails loudly for malformed or
unreachable states. The shared primitive remains small enough for worker
startup.

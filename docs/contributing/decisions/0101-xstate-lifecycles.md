# 0101: Model operations, not arbitrary status-pair graphs

- **Status:** accepted
- **Date:** 2026-11-10

## Context

[0100](./0100-explicit-state-machines.md) centralized status-pair tables, but
their edges over-approximated actual operations. Complete graphs and unexplained
self-loops hid duplicate submission, stale-response and lease-ownership rules.
Some columns genuinely accept arbitrary replacement; presenting those enums as
lifecycles invented constraints the application did not enforce.

## Decision

Use domain-owned **XState 6.0.0-beta.1** machines with **@xstate/react
7.0.0-beta.0** for constrained server lifecycles, UI flows and desktop
operations. Derive named events from actual callers, put payload in context, and
declare `type: 'final'` only when no operation leaves that state. Do not encode
a generic status setter as a complete graph. Use `defineStatusEnum` for
unconstrained columns; derived display values need no actor. Keep
framework-owned request state in its framework.

The shared API in `packages/shared/src/state-machine.ts` provides
`LifecycleStateOf`, `statesOf`, `finalStatesOf`, `isState`, `parseState`,
`nextState`, `canHandle`, `sourcesOf`, `sqlSourcesOf`, `sqlStatesOf`,
`sqlSourceOf`. `defineStatusEnum` supplies membership, parsing and SQL values
without edges. Legacy `defineStateMachine` is removed.

Use `nextState(machine, from, event)` to validate an operation. Context
initializers require explicit context; payload-dependent guards require a full
event, not the type-only `canHandle` probe. SQL CAS source lists come from
`sqlSourcesOf`; preserve predicate order with explicit source subsets where
needed. Structural sources do not replace authorization, expiry, expected-value
or claim-ownership predicates. Fence settlement on the acquired lease/claim.

UI components use `@xstate/react`: actors synchronously ignore duplicate
submits, and request IDs or canceled invocations fence stale responses. Preserve
initial SSR snapshots, DOM, accessibility, focus and timing. Desktop CJS uses
`require('xstate')`; XState is a production dependency, and packaged startup
checks resolve and execute it from the app's own dependencies.

Register domain definitions in package registries and `tools/state-machines.ts`.
Registry tests require unique IDs, complete registration, reachable states,
handled declared events and genuinely terminal finals. Generate the
[reference](../state-machines.md) with `npm run state-machines:generate`; do not
maintain a second graph in documentation.

The tooling-only TypeScript AST extractor in `tools/state-machine-graph.ts`
drives Mermaid, declared-event and reachability checks. It fails closed on
computed destinations or unsupported return forms: v6 runtime graphs cannot
recover function destinations. Conditional handlers call named predicates from
`setup({ guards })`; diagrams and tables derive branch labels from those calls,
including refused-event checks and fallback branches. A human-readable
`description` is required only for conditions without named guards. Runtime SQL
helpers inspect handlers without evaluating guards and never import TypeScript.
Infer flat persisted state unions from `SnapshotFrom<M>['value']` rather than
the beta's overloaded `StateValueFrom` helper.

## Measurements

For the v6 upgrade, shipped core minified/gzip bytes are 47,486/14,589 for
5.33.3 versus 145,053/43,407 for 6.0.0-beta.1 (**+28,818 gzip bytes**). With
identical esbuild settings, the `setup`/`createActor`/`transition` ESM subset is
39,005/12,834 versus 88,981/28,494 (**+15,660 gzip bytes**). These gzip-level-9
library measurements are not whole-application deltas.

Against main at `aeaa6a6e7`, the v6 client build contains 736 JavaScript files
versus 735: 3,820,053 → 3,875,574 raw bytes (**+55,521**) and 1,349,378 →
1,366,767 gzip bytes (**+17,389**). These are sums of individual client
JavaScript files using the same default gzip settings as the v5 migration
comparison, not the core-library gzip-level-9 measurements above. Before
cleanup, startup bytes were: origin 805,701 → 805,943; platform 7,160,252 →
7,445,423; runtime 5,477,241 → 5,761,716. Platform/runtime already exceed the
reviewed warning-only byte budgets on main; budgets and SQL CAS semantics are
unchanged.

The original v5 client build comparison retained 735 JavaScript files: 3,755,342
→ 3,819,416 raw bytes (**+64,074**), 1,330,642 → 1,349,426 gzip bytes
(**+18,784**). These are whole-build migration deltas, not an isolated
library-size measurement.

The foundation/server migration measured startup entry deltas of **+860 origin,
+59,009 platform and +58,191 runtime bytes** against clean main `3299d97e1`.
Platform (7,093,212 bytes) and runtime (5,414,769 bytes) were already above
their byte budgets on that baseline. Best-of-three active CPU after that
migration was 53.6/125.8/86.5 ms (origin/platform/runtime), below 280/340/160 ms
limits. Recheck both CPU and bytes after dependency or lifecycle changes; byte
warnings are not evidence of a CPU regression or permission to raise budgets.

After the complete migration and bug fixes, a comparison against clean main
`26e325960` measured:

| Entry    | Main bytes | Migration bytes | Delta   | Main → migration CPU |
| -------- | ---------- | --------------- | ------- | -------------------- |
| Origin   | 804,154    | 805,701         | +1,547  | 55.9 → 55.2 ms       |
| Platform | 7,094,923  | 7,156,222       | +61,299 | 130.0 → 144.5 ms     |
| Runtime  | 5,416,491  | 5,476,195       | +59,704 | 79.2 → 86.1 ms       |

CPU is best-of-three active time, not wall time. Both byte checks exited zero
with the existing platform/runtime overage warnings; no budgets were changed.

## Consequences

Events explain real same-state data updates, while enums stop pretending to
constrain arbitrary replacement. Pure validation and SQL share declarations;
actors own UI concurrency instead of parallel status booleans and single-flight
helpers. Guard-aware graph tests still need focused runtime and database race
tests: a machine cannot make an unfenced SQL write safe.

XState adds runtime and client bytes and requires packaged dependency checks.
The migration preserves stored values and wire contracts; stale billing/DLQ
settlement and rejected-referral resurrection are separately regression-tested
bug fixes. Revisit the runtime choice if measured startup or bundle cost exceeds
reviewed budgets, not by reintroducing anonymous transition-pair tables.

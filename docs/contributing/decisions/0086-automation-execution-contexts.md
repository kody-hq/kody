# 0086: Automations choose an execution context

- **Status:** accepted
- **Date:** 2026-10-28

## Context

Ad hoc `execute` can name an
[execution context](../architecture/execution-contexts.md), pass `requires`, and
fall back to the caller's chain. Jobs, webhooks, subscriptions and package
workflow steps always ran on Kody cloud, so an automation that only works on one
machine could not say so.

## Decision

- Automations carry an `execution` setting with the same shape as execute
  routing: `context` (no fallback unless `fallback: "chain"`), or their own
  `chain` (up to 3 contexts, `"cloud"` only last, no cloud means strict), plus
  `requires: ["fs" | "lan"]`. Ad hoc execute accepts the same `chain`.
- Precedence: a per-run or per-automation `context` or `chain` overrides the
  person's default chain. For an automation, an override set through the API,
  MCP (`automationExecutionSet`) or UI wins over the package manifest's
  `execution` (`kody.jobs.<name>`, `kody.webhooks[]`,
  `kody.subscriptions.<topic>`). Workflow steps take `execution` on
  `workflows.create`. A workflow step needs its result before the next step, so
  it cannot queue, and a context run that outlives the wait fails the step. An
  override of `{ context: "cloud" }` pins an automation to Kody cloud even when
  its manifest names a context; clearing the override restores the manifest
  setting.
- Chains are followed in order. Entries that are unknown, inaccessible, offline,
  busy, unusable, or lack `requires` are skipped. When nothing qualifies the run
  fails with each entry and why, and the run record shows it.
- Offline (or busy) fails by default. `whenOffline: "queue"` holds the run on
  the context's session only when no target in the chain can take it (a
  reachable later entry, including Kody cloud, runs instead) until it
  reconnects, for `queueMinutes` (default 60, max 1440). On reconnect the
  context, the person's access, the grant and its version, the person's org
  membership and the flag are checked again before dispatch; a queued run whose
  context was revoked, deleted or narrowed fails, and revoking a context fails
  its queue at once. A connected context that is busy or not accepting runs is
  retried every 30 seconds and on each status update. Expiry fails the run with
  `execution_context_queue_expired`.
- An automation's context run uses the access of the person it runs as
  (`callerContext.request.actor`): the job owner, the trigger enabler, or the
  workflow's lineage actor. That is the same actor background runs already bill
  and attribute to, and every hop re-checks that person's access. A trigger with
  no actor fails instead of picking someone.
- The automation's own run record stays owned by its runner; the context run is
  a child run record (`parentRunId`) owned by the context session.
- Only package exports can run on a context, because the context imports the
  export. Inline workflow code and handlers that are not exports reject an
  `execution` setting.
- ADR 0083 holds: credential values never reach a context; context runs never
  start workflows or run `execute`.
- Everything is behind the `execution-contexts` flag, checked for the run's
  actor before any setting is read. With the flag off, management (API, MCP,
  CLI, UI) answers `feature_disabled` and automations run on Kody cloud exactly
  as before, even when a manifest declares `execution`: an org without the flag
  has no contexts to run on, and a flagless run costs no extra reads. Ad hoc
  `execute` routing fields still fail with `feature_disabled`, because that
  caller asked for a context explicitly.

## Consequences

- One automation can target a machine without changing anyone's default chain.
- Queued runs are bounded, so a machine that never returns cannot hold work
  forever.
- Moving an automation to a context changes where its code runs but not who pays
  or whose access it uses.

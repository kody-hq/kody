# Bugs surfaced by the Effect migration

Line numbers are on `main` at `43a10d2663f91a6af377ddc86c856dddc3c11f0b`. For
these three files the Promise implementation on the trial branch is identical to
`main` (the branch only adds Effect code beside it), so each
`promise path (still has the bug)` test is a `test.fails` run of the same code
as `main`: it fails on `main` and on the branch Promise path, and the matching
`effect path` test passes.

## v5 widening (scheduled cleanup lanes)

| #   | File and line on main                                                                      | Bug and impact                                                                                                                                                                                                                                                                                                                                                                                                              | How it surfaced                                                                                                                                                                                                               | Test                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/worker/src/orgs/org-audit-outbox.ts:231` (delete), `:234` (emit), `:240` (catch) | `tryDeliverOrgAuditOutboxPlan` deletes the outbox row before it schedules the resource change event. If that delete fails after the audit row was inserted, the catch returns false. The retry then gets `already_exists`, which never emits. The resource change event for that audit row is lost for good, so packages subscribed to the change never run. The catch also drops the error without logging it.             | Exhaustive error mapping: typing the outbox step's failures (`DatabaseError` from the delete) made it clear that a failure after the insert was folded into the same `false` as a failure before it.                          | `org-audit-outbox.node.test.ts`: `a failed outbox delete after insert still emits the resource change event once`            |
| 2   | `packages/worker/src/email/reconcile-inbound-deliveries.ts:211`, `:216`, `:229`, `:231`    | The Mailbox due-work hint refresh (`getInboundDueWorkHint`, `replaceInboundDueOwnerHint`) runs inside the same try as the owner's reconcile, after `usersProcessed += 1`. If the refresh fails, the catch adds `usersProcessed += 1` again, so one owner is counted twice. The lane result and logs overstate the owners processed, and an owner whose reconcile succeeded is reported and deferred as a reconcile failure. | Plain code reading while migrating, when splitting the owner step and the hint refresh into separate outbound calls with their own typed failures.                                                                            | `reconcile-inbound-deliveries.node.test.ts`: `a failed Mailbox hint refresh after a reconciled owner counts that owner once` |
| 3   | `packages/worker/src/repo/repo-session-cleanup.ts:34` (loop at `:29`)                      | `cleanupRepoSessionBranches` awaits each owner's `RepoSessionIndex.runDueCleanup` RPC with no deadline. One wedged index holds the whole lane: later owners in the batch are not cleaned up, and the wedged owner is never deferred, so it stays first in `due_at` order and blocks the next tick the same way.                                                                                                             | Timeout requirement: every outbound call in the Effect path goes through `outbound` with a 30 second deadline. With it, a wedged RPC fails as `OutboundCallError` (`timeout`), the owner is deferred, and the loop continues. | `repo-session-cleanup.node.test.ts`: `a wedged index RPC defers its owner and later owners still run`                        |

The branch Promise path still has all three bugs. It is not fixed, so the
comparison with `main` stays fair.

## Original retention slice

None confirmed beyond what the earlier pass recorded.

## Near misses (not counted)

- `packages/worker/src/oauth-purge.ts:486` to `:497` on main: runs queue on
  `#previousRun` and the KV calls have no deadline, so one hung KV call would
  hold every later run until the object is evicted. Found through the timeout
  requirement. Not demonstrated with a test, and the trial branch still has the
  older `blockConcurrencyWhile` coordinator, so it is not counted.
- `packages/worker/src/email/system-email.ts` retention and the
  `scheduled-lanes.ts` failure isolation (lease release in `finally`, lock
  contention mapping, Sentry scope): Schema decode on every row and the scoped
  lease release path matched the Promise behavior in every ported test. Nothing
  found.
- `reconcile-inbound-deliveries.ts` system due-work query: `MIN(due_at)` could
  in theory be NULL, which the Promise sort would crash on. The Schema decode
  would reject it, but every `due_work` branch selects a non-null column, so
  this cannot happen.

# Account write lease repair

Account write leases expire. A lease lapses 2 minutes after its last renewal,
and a running writer renews it every 30 seconds
(`packages/worker/src/account/write-lease-timing.ts`). A writer whose isolate
was killed stops renewing, so it stops blocking account and org deletion on its
own. Once a deletion is waiting, a lapsed lease is dropped: a writer that comes
back afterwards has lost its lease and its write fails.

A deletion refused by active writes returns a `409` (`account_writes_active`)
that names the holders. A blocking lease that is still held after 5 minutes is
reported to Sentry as a warning, because a live writer should not run that long.
Manual repair is for that case: a writer that keeps renewing but will not
finish.

Read-only MCP traffic (`initialize`, `tools/list`, `ping`, and `search`) does
not acquire a write lease; mutating `tools/call` (including `execute`) still
does. Deleting accounts are rejected on both paths via D1 `users.deleting_at`.

Active leases live in the UserMeter DO. All callers supply `env` (including
email paths), so every lease is a UserMeter-authoritative row. D1 has no
`account_write_leases` table; `account_write_lease_repairs` remains the audit
log for all repairs in `packages/worker/migrations/0001-squashed-init.sql`.

First inspect active leases:

```javascript
await kody.adminAccountWriteLeaseList({
	stable_user_id: 'user-id-from-admin-account-lookup',
})
```

Review the returned token, holder, and `acquired_at` timestamp against runtime
logs before repair. Then release exactly that inspected lease:

```javascript
await kody.adminAccountWriteLeaseRepair({
	stable_user_id: 'user-id-from-admin-account-lookup',
	token: '00000000-0000-4000-8000-000000000000',
	expected_acquired_at: '2026-07-23 05:00:00',
	reason: 'Confirmed worker invocation terminated; no process remains.',
})
```

The repair writes an `account_write_lease_repairs` audit row before releasing
the token. Repair uses the DO-only path: prepare (stable `repairId`, lease stays
held) → audit insert/verify → finalize DO deletion. Retries after a lost
finalize response succeed when the matching audit exists and the DO lease is
already gone. Wrong user, stale timestamp, or short reason requests fail closed.
Retry account deletion only after inspection shows no active leases.

Hard-deleting an account immediately, and freeing its handle, is
`adminUserAccountDelete`. That capability only returns an approval URL. The
admin approves on the page (or confirms in the admin users modal by typing the
handle). It does not replace `adminAccountDeletionAbort` when a leftover fence
needs to be cleared.

A failed delete that marked `users.deleting_at` before cleanup can leave the
account fenced with no active leases. Confirm with `adminUserMeterParity`
(`deletion.d1DeletingAt` / `deletion.meterDeletingAt`), then clear both sides:

```javascript
await kody.adminAccountDeletionAbort({
	stable_user_id: 'user-id-from-admin-account-lookup',
	reason:
		'Leftover fence after a pre-cleanup delete failure; no writers remain.',
})
```

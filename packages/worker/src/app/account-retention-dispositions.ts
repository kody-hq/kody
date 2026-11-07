export type AccountRetentionDisposition =
	| { table: string; kind: 'scheduled_policy' }
	| { table: string; kind: 'alternate_cleanup'; reason: string }
	| { table: string; kind: 'durable_forever'; reason: string }

export const accountRetentionDispositions: ReadonlyArray<AccountRetentionDisposition> =
	[
		{
			table: 'mcp_memory_conversation_suppressions',
			kind: 'scheduled_policy',
		},
		{ table: 'platform_feedback', kind: 'scheduled_policy' },
		{ table: 'published_bundle_artifacts', kind: 'scheduled_policy' },
		{ table: 'usage_rollups', kind: 'scheduled_policy' },
		{ table: 'feature_flag_exposure_rollups', kind: 'scheduled_policy' },
		{ table: 'stripe_webhook_events', kind: 'scheduled_policy' },
		{ table: 'credential_local_read_events', kind: 'scheduled_policy' },
		{
			table: 'agent_package_conversation_uses',
			kind: 'scheduled_policy',
		},
		{
			table: 'system_email_delivery_events',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 delivery events are excluded from account retention; the dedicated system-email retention lane applies its 90-day policy.',
		},
		{
			table: 'system_email_messages',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 messages are excluded from account retention; the dedicated authority enforces the 90-day age and 5,000-message cap with R2-before-row deletion.',
		},
		{
			table: 'system_email_attachments',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 attachment metadata follows dedicated system messages; referenced R2 objects are deleted before authority metadata.',
		},
		{
			table: 'system_email_threads',
			kind: 'alternate_cleanup',
			reason:
				'Operator-owned D1 threads are pruned from the dedicated authority when orphaned.',
		},
		{
			table: 'usage_connection_daily',
			kind: 'alternate_cleanup',
			reason:
				'The hourly usage aggregation lane prunes per-connection usage rows older than 14 days.',
		},
		{
			table: 'mcp_memories',
			kind: 'durable_forever',
			reason:
				'Memories are durable user-curated content removed by explicit user action or account deletion, not by time-based retention.',
		},
		{
			table: 'user_storage_buckets',
			kind: 'durable_forever',
			reason:
				'Per-user durable storage bucket ownership is current state for backup, export, and deletion enumeration; it is removed only by account deletion.',
		},
		{
			table: 'durable_object_duration_daily',
			kind: 'durable_forever',
			reason:
				'Per-user daily Durable Object active-time estimates are usage history (like usage_rollups) removed only by account deletion.',
		},
		{
			table: 'credit_wallets',
			kind: 'durable_forever',
			reason:
				'Prepaid credit balances and wallet settings are current billing state removed only by account deletion.',
		},
		{
			table: 'org_plan_transfers',
			kind: 'durable_forever',
			reason:
				'Plan moves between orgs are the billing record for the Stripe credit note, cancellation, and customer balance credit; the requesting owner is anonymized on account deletion.',
		},
		{
			table: 'credit_ledger_entries',
			kind: 'durable_forever',
			reason:
				'Credit top-ups, auto-refills, admin grants, and debits are the billing and audit record for the balance; removed only by account deletion.',
		},
		{
			table: 'credit_debit_progress',
			kind: 'durable_forever',
			reason:
				'Per-month debit progress keeps hourly debits idempotent; removed only by account deletion.',
		},
	] as const

export function getAccountRetentionDispositionCoverage(): Set<string> {
	return new Set(
		accountRetentionDispositions.map((disposition) => disposition.table),
	)
}

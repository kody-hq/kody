/**
 * Track mail providers (by MX host suffix) that are rejecting kody.codes with
 * blocklist / DBL responses. Holdable transactional mail to recipients whose
 * MX resolves to an active rejecting provider is skipped until rejections age
 * out or a successful delivery clears the provider.
 */

import { resolveRecipientMxProviders } from './mx-lookup.ts'
import {
	classifyRecipientDeliveryFailure,
	type EmailPolicyWriteGuard,
} from './recipient-cooldown.ts'
import { type EmailDeliveryStatus } from './types.ts'
import { type EmailVerificationDeliveryStatus } from '#universal/email-verification-delivery.ts'

/** How long a provider stays "rejecting" after the last observed rejection. */
export const emailRejectingProviderTtlMs = 24 * 60 * 60 * 1000

export const emailProviderHoldMessage =
	'Your mail provider is blocking our domain right now, try another address.'

export type RejectingProviderRow = {
	providerKey: string
	lastRejectionAt: string
	rejectionCount: number
	lastRecipientDomain: string | null
	seeded: boolean
}

function isRejectingProviderTimestampActive(
	lastRejectionAt: string,
	now: Date,
): boolean {
	// SQLite CURRENT_TIMESTAMP is `YYYY-MM-DD HH:MM:SS` (UTC in D1). Normalize
	// to ISO so it parses and compares as a real instant, not lexicographically
	// against Date.toISOString() cutoffs.
	const normalized = lastRejectionAt.includes('T')
		? lastRejectionAt
		: `${lastRejectionAt.replace(' ', 'T')}Z`
	const lastMs = Date.parse(normalized)
	if (!Number.isFinite(lastMs)) return false
	return now.getTime() - lastMs <= emailRejectingProviderTtlMs
}

export async function listActiveRejectingProviders(input: {
	db: D1Database
	now?: Date
}): Promise<Array<RejectingProviderRow>> {
	const now = input.now ?? new Date()
	try {
		// Filter in JS so SQLite CURRENT_TIMESTAMP seeds (space separator)
		// and ISO writes from recordRejectingProvidersForRecipient both
		// keep a true 24h window against Date-based cutoffs.
		const result = await input.db
			.prepare(
				`SELECT provider_key, last_rejection_at, rejection_count,
				        last_recipient_domain, seeded
				 FROM email_rejecting_providers
				 ORDER BY last_rejection_at DESC`,
			)
			.all<{
				provider_key: string
				last_rejection_at: string
				rejection_count: number
				last_recipient_domain: string | null
				seeded: number
			}>()
		return (result.results ?? [])
			.filter((row) =>
				isRejectingProviderTimestampActive(row.last_rejection_at, now),
			)
			.map((row) => ({
				providerKey: row.provider_key,
				lastRejectionAt: row.last_rejection_at,
				rejectionCount: row.rejection_count,
				lastRecipientDomain: row.last_recipient_domain,
				seeded: row.seeded === 1,
			}))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (
			error instanceof TypeError ||
			/no such table/i.test(message) ||
			/\.all is not a function/i.test(message)
		) {
			return []
		}
		throw error
	}
}

export async function isRejectingProviderActive(input: {
	db: D1Database
	providerKey: string
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	const row = await input.db
		.prepare(
			`SELECT last_rejection_at
			 FROM email_rejecting_providers
			 WHERE provider_key = ?`,
		)
		.bind(input.providerKey)
		.first<{ last_rejection_at: string }>()
	if (!row) return false
	return isRejectingProviderTimestampActive(row.last_rejection_at, now)
}

type RejectingProvidersInput = {
	db: D1Database
	recipient: string
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	now?: Date
	fetchImpl?: typeof fetch
}

/**
 * Resolves the recipient's MX providers and builds their rejection upserts
 * without running them. With `onlyIf`, each row is written only when that
 * condition holds at commit time.
 */
export async function prepareRejectingProviderUpserts(
	input: RejectingProvidersInput & { onlyIf?: EmailPolicyWriteGuard },
): Promise<{
	providerKeys: Array<string>
	statements: Array<D1PreparedStatement>
}> {
	const deliveryClass = classifyRecipientDeliveryFailure({
		status: input.status,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	if (deliveryClass !== 'sender_block') {
		return { providerKeys: [], statements: [] }
	}

	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const statements = mx.providerKeys.map((providerKey) =>
		input.db
			.prepare(
				`INSERT INTO email_rejecting_providers (
					provider_key, last_rejection_at, rejection_count,
					last_recipient_domain, seeded, created_at, updated_at
				 ) SELECT ?, ?, 1, ?, 0, ?, ? WHERE ${input.onlyIf?.sql ?? '1'}
				 ON CONFLICT(provider_key) DO UPDATE SET
					last_rejection_at = excluded.last_rejection_at,
					rejection_count = email_rejecting_providers.rejection_count + 1,
					last_recipient_domain = excluded.last_recipient_domain,
					updated_at = excluded.updated_at`,
			)
			.bind(
				providerKey,
				nowIso,
				mx.domain || null,
				nowIso,
				nowIso,
				...(input.onlyIf?.binds ?? []),
			),
	)
	return { providerKeys: mx.providerKeys, statements }
}

export async function recordRejectingProvidersForRecipient(
	input: RejectingProvidersInput,
): Promise<Array<string>> {
	const prepared = await prepareRejectingProviderUpserts(input)
	for (const statement of prepared.statements) {
		await statement.run()
	}
	return prepared.providerKeys
}

/**
 * A successful delivery to a recipient clears every provider key that
 * currently resolves for that address, so the hold lifts as soon as the
 * provider accepts mail again (for example after Spamhaus delisting).
 */
export async function clearRejectingProvidersForRecipient(input: {
	db: D1Database
	recipient: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<Array<string>> {
	// Ordinary delivered mail should not pay for MX/DoH when nothing is
	// currently marked rejecting.
	const active = await listActiveRejectingProviders({
		db: input.db,
		now: input.now,
	})
	if (active.length === 0) return []
	const activeKeys = new Set(active.map((row) => row.providerKey))

	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	const cleared: Array<string> = []
	for (const providerKey of mx.providerKeys) {
		if (!activeKeys.has(providerKey)) continue
		await input.db
			.prepare(`DELETE FROM email_rejecting_providers WHERE provider_key = ?`)
			.bind(providerKey)
			.run()
		cleared.push(providerKey)
	}
	return cleared
}

export async function findActiveRejectingProviderForRecipient(input: {
	db: D1Database
	recipient: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<string | null> {
	// Skip MX/DoH when nothing is currently marked rejecting — the common
	// path after delisting and in tests without the policy tables.
	const active = await listActiveRejectingProviders({
		db: input.db,
		now: input.now,
	})
	if (active.length === 0) return null

	const mx = await resolveRecipientMxProviders({
		db: input.db,
		recipientOrDomain: input.recipient,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	const activeKeys = new Set(active.map((row) => row.providerKey))
	for (const providerKey of mx.providerKeys) {
		if (activeKeys.has(providerKey)) return providerKey
	}
	return null
}

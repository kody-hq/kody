import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	generateUserCode,
	hashDeviceCode,
} from '#worker/oauth-device/device-grant.ts'

/** Outer claim window: an unclaimed registration expires after a day. */
export const agentRegistrationTtlSeconds = 24 * 60 * 60

/** One claim attempt (user code plus verification URI) lasts ten minutes. */
export const agentClaimAttemptTtlSeconds = 10 * 60

/** Minimum poll interval the agent must honor (RFC 8628 default). */
export const agentClaimPollIntervalSeconds = 5

/** Every `slow_down` adds five seconds to the interval (RFC 8628 3.5). */
export const agentClaimSlowDownIncrementSeconds = 5

/** Expired rows stay this long so a late poll still sees `expired_token`. */
export const agentRegistrationRetentionSeconds = 24 * 60 * 60

export type AgentRegistrationStatus =
	| 'pending'
	| 'claimed'
	| 'denied'
	| 'consumed'

export type AgentRegistrationRow = {
	id: string
	claim_token_hash: string
	claim_email: string
	status: AgentRegistrationStatus
	attempt_id: string
	attempt_token_hash: string
	user_code_hash: string
	attempt_expires_at: number
	interval_seconds: number
	last_polled_at: number | null
	idle_ttl_seconds: number
	max_lifetime_seconds: number
	created_at: number
	expires_at: number
	user_id: string | null
	org_id: string | null
	claimed_at: number | null
	consumed_at: number | null
}

export type AgentClaimAttempt = {
	attemptId: string
	attemptToken: string
	attemptTokenHash: string
	userCode: string
	userCodeHash: string
	attemptExpiresAt: number
}

const table = 'agent_registrations'

export function nowSeconds() {
	return Math.floor(Date.now() / 1000)
}

function randomSecret(prefix: string) {
	return `${prefix}${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
}

export function generateClaimToken() {
	return randomSecret('kody_clm_')
}

/** SHA-256 (base64url) of a claim token, attempt token, or user code. */
export const hashAgentRegistrationSecret = hashDeviceCode

export async function createClaimAttempt(
	now = nowSeconds(),
): Promise<AgentClaimAttempt> {
	const attemptToken = randomSecret('kody_cla_')
	const userCode = generateUserCode()
	return {
		attemptId: crypto.randomUUID(),
		attemptToken,
		attemptTokenHash: await hashAgentRegistrationSecret(attemptToken),
		userCode,
		userCodeHash: await hashAgentRegistrationSecret(userCode),
		attemptExpiresAt: now + agentClaimAttemptTtlSeconds,
	}
}

export async function purgeExpiredAgentRegistrations(
	db: D1Database,
	now = nowSeconds(),
) {
	await db
		.prepare(`DELETE FROM ${table} WHERE expires_at < ?`)
		.bind(now - agentRegistrationRetentionSeconds)
		.run()
}

export async function insertAgentRegistration(
	db: D1Database,
	input: {
		id: string
		claimTokenHash: string
		claimEmail: string
		attempt: AgentClaimAttempt
		idleTtlSeconds: number
		maxLifetimeSeconds: number
		now: number
	},
) {
	await db
		.prepare(
			`INSERT INTO ${table} (
				id, claim_token_hash, claim_email, status, attempt_id,
				attempt_token_hash, user_code_hash, attempt_expires_at,
				interval_seconds, idle_ttl_seconds, max_lifetime_seconds,
				created_at, expires_at
			)
			VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.claimTokenHash,
			input.claimEmail,
			input.attempt.attemptId,
			input.attempt.attemptTokenHash,
			input.attempt.userCodeHash,
			input.attempt.attemptExpiresAt,
			agentClaimPollIntervalSeconds,
			input.idleTtlSeconds,
			input.maxLifetimeSeconds,
			input.now,
			input.now + agentRegistrationTtlSeconds,
		)
		.run()
}

export async function findAgentRegistrationByClaimTokenHash(
	db: D1Database,
	claimTokenHash: string,
) {
	return await db
		.prepare(`SELECT * FROM ${table} WHERE claim_token_hash = ?`)
		.bind(claimTokenHash)
		.first<AgentRegistrationRow>()
}

/** A pending registration whose current attempt and outer window are open. */
export async function findOpenAgentRegistrationByAttemptTokenHash(
	db: D1Database,
	attemptTokenHash: string,
	now = nowSeconds(),
) {
	return await db
		.prepare(
			`SELECT * FROM ${table}
			WHERE attempt_token_hash = ? AND status = 'pending'
				AND attempt_expires_at > ? AND expires_at > ?`,
		)
		.bind(attemptTokenHash, now, now)
		.first<AgentRegistrationRow>()
}

/** Replaces the claim attempt; the previous verification URI stops working. */
export async function replaceClaimAttempt(
	db: D1Database,
	id: string,
	attempt: AgentClaimAttempt,
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET attempt_id = ?, attempt_token_hash = ?, user_code_hash = ?,
				attempt_expires_at = ?, interval_seconds = ?, last_polled_at = NULL
			WHERE id = ? AND status = 'pending' AND expires_at > ?`,
		)
		.bind(
			attempt.attemptId,
			attempt.attemptTokenHash,
			attempt.userCodeHash,
			attempt.attemptExpiresAt,
			agentClaimPollIntervalSeconds,
			id,
			now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Records one poll against the row the caller just read. A poll sooner than
 * the stored interval is `slow_down` and grows the interval. The write is
 * conditional on the `last_polled_at` that was read, so racing polls cannot
 * both count as on time.
 */
export async function recordAgentClaimPoll(
	db: D1Database,
	row: Pick<AgentRegistrationRow, 'id' | 'last_polled_at' | 'interval_seconds'>,
	now = nowSeconds(),
): Promise<{ tooFast: boolean; intervalSeconds: number }> {
	const tooFast =
		row.last_polled_at !== null &&
		now - row.last_polled_at < row.interval_seconds
	const intervalSeconds = tooFast
		? row.interval_seconds + agentClaimSlowDownIncrementSeconds
		: row.interval_seconds
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET interval_seconds = ?, last_polled_at = ?
			WHERE id = ? AND last_polled_at IS ?`,
		)
		.bind(intervalSeconds, now, row.id, row.last_polled_at)
		.run()
	if ((result.meta.changes ?? 0) === 0) {
		await db
			.prepare(
				`UPDATE ${table} SET interval_seconds = interval_seconds + ?
				WHERE id = ?`,
			)
			.bind(agentClaimSlowDownIncrementSeconds, row.id)
			.run()
		return {
			tooFast: true,
			intervalSeconds:
				row.interval_seconds + agentClaimSlowDownIncrementSeconds,
		}
	}
	return { tooFast, intervalSeconds }
}

export async function decideAgentRegistration(
	db: D1Database,
	input:
		| {
				id: string
				attemptId: string
				decision: 'claimed'
				userId: string
				orgId: string
		  }
		| { id: string; attemptId: string; decision: 'denied'; userId: string },
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table}
			SET status = ?, user_id = ?, org_id = ?, claimed_at = ?
			WHERE id = ? AND attempt_id = ? AND status = 'pending'
				AND attempt_expires_at > ? AND expires_at > ?`,
		)
		.bind(
			input.decision,
			input.userId,
			input.decision === 'claimed' ? input.orgId : null,
			now,
			input.id,
			input.attemptId,
			now,
			now,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Moves a claimed row to consumed. Only one poll can win. */
export async function consumeClaimedAgentRegistration(
	db: D1Database,
	id: string,
	now = nowSeconds(),
) {
	const result = await db
		.prepare(
			`UPDATE ${table} SET status = 'consumed', consumed_at = ?
			WHERE id = ? AND status = 'claimed' AND expires_at > ?`,
		)
		.bind(now, id, now)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Undo a consume when the token mint failed, so the next poll can retry. */
export async function restoreClaimedAgentRegistration(
	db: D1Database,
	id: string,
) {
	await db
		.prepare(
			`UPDATE ${table} SET status = 'claimed', consumed_at = NULL
			WHERE id = ? AND status = 'consumed'`,
		)
		.bind(id)
		.run()
}

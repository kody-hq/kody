import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { deleteUserAccount } from '#app/account-deletion.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { maybeGrantSignupWelcomeCredits } from '#worker/billing/signup-welcome-credits.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { buildMemoryEmbedTextFromRow } from '#mcp/memory/memory-embed.ts'
import {
	deleteMemoryVector,
	upsertMemoryVector,
} from '#mcp/memory/memory-vectorize.ts'
import type { McpMemoryRow } from '#mcp/memory/types.ts'
import { runOrgResourceTransfer } from '#worker/org-transfer/apply.ts'
import { defaultOrgTransferEffects } from '#worker/org-transfer/effects.ts'
import { runLogRpc } from '#worker/run-records/service.ts'
import { scheduleGuestClaimedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import type {
	GuestClaimCounts,
	GuestClaimMethod,
} from '#worker/identity/user-lifecycle-subscription-event.ts'
import {
	guestConversionStatements,
	guestPhase,
	type GuestAccount,
} from './guest-accounts.ts'

export type GuestClaimErrorCode =
	| 'already_claimed'
	| 'deleted'
	| 'username_invalid'
	| 'username_taken'
	| 'email_taken'
	| 'no_account'
	| 'merge_blocked'

export class GuestClaimError extends Error {
	readonly code: GuestClaimErrorCode
	constructor(code: GuestClaimErrorCode, message: string) {
		super(message)
		this.name = 'GuestClaimError'
		this.code = code
	}
}

/** How the person claimed, for the `user.guest_claimed` admin event. */
type GuestClaimVia = {
	method?: GuestClaimMethod
	provider?: string | null
}

export type GuestClaimTarget = {
	dbUserId: number
	personId: string
	personalOrgId: string
	username: string
	email: string
}

export type GuestClaimResult = {
	mode: 'new' | 'merge'
	username: string
	personId: string
	personalOrgId: string
	renamedPackages: Array<{ from: string; to: string }>
}

type GuestUserRow = {
	id: number
	stable_user_id: string
	username: string
	personal_org_id: string | null
}

/** The guest user row while the guest is still claimable. */
export async function readClaimableGuestUser(
	db: D1Database,
	guest: GuestAccount,
): Promise<GuestUserRow> {
	if (guest.claimedAt) {
		throw new GuestClaimError(
			'already_claimed',
			'This guest account was already claimed.',
		)
	}
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, username, personal_org_id FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL AND guest_expires_at IS NOT NULL`,
		)
		.bind(guest.personId)
		.first<GuestUserRow>()
	if (!row) {
		throw new GuestClaimError('deleted', 'This guest account no longer exists.')
	}
	return row
}

export async function assertClaimUsernameAvailable(
	env: Env,
	username: string,
	guestPersonId: string,
) {
	const normalized = normalizeUsername(username)
	const invalid = normalized
		? await getEffectiveUsernameValidationError(normalized, env)
		: 'Pick a username.'
	if (!normalized || invalid) {
		throw new GuestClaimError('username_invalid', invalid ?? 'Pick a username.')
	}
	if (
		await isUsernameClaimedInIdentity(env.APP_DB, normalized, {
			exceptStableUserId: guestPersonId,
		})
	) {
		throw new GuestClaimError(
			'username_taken',
			`The username ${normalized} is taken. Pick another one.`,
		)
	}
	return normalized
}

/** A live, verified, non-guest account for this email, if any. */
export async function findClaimTargetByEmail(
	db: D1Database,
	email: string,
): Promise<GuestClaimTarget | null> {
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, username, personal_org_id, email FROM users
			 WHERE email = ? AND deleted_at IS NULL AND deleting_at IS NULL
			   AND guest_expires_at IS NULL AND email_verified_at IS NOT NULL`,
		)
		.bind(email)
		.first<GuestUserRow & { email: string }>()
	return row ? claimTargetFromRow(row) : null
}

export async function findClaimTargetByDbId(
	db: D1Database,
	dbUserId: number,
): Promise<GuestClaimTarget | null> {
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, username, personal_org_id, email FROM users
			 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL
			   AND guest_expires_at IS NULL AND email_verified_at IS NOT NULL`,
		)
		.bind(dbUserId)
		.first<GuestUserRow & { email: string }>()
	return row ? claimTargetFromRow(row) : null
}

function claimTargetFromRow(
	row: GuestUserRow & { email: string },
): GuestClaimTarget {
	return {
		dbUserId: row.id,
		personId: row.stable_user_id,
		personalOrgId:
			row.personal_org_id ?? personalOrgId(row.stable_user_id as never),
		username: row.username,
		email: row.email,
	}
}

/**
 * Claim into a new account: the guest becomes a regular account in place,
 * so its OAuth grants and CLI logins keep working untouched.
 */
export async function convertGuestInPlace(
	input: {
		env: Env
		guest: GuestAccount
		email: string
		username: string
		displayName?: string | null
		now?: Date
	} & GuestClaimVia,
): Promise<GuestClaimResult> {
	const { env, guest } = input
	const db = env.APP_DB
	const countsPromise = guestClaimCounts(env, guest)
	const user = await readClaimableGuestUser(db, guest)
	const username = await assertClaimUsernameAvailable(
		env,
		input.username,
		guest.personId,
	)
	if (await findClaimTargetByEmail(db, input.email)) {
		throw new GuestClaimError(
			'email_taken',
			'That email already has a Kody account. Claim into that account instead.',
		)
	}
	const counts = await countsPromise
	const claimDate = input.now ?? new Date()
	const now = claimDate.toISOString()
	const orgId = guest.personalOrgId
	const statements = [
		db
			.prepare(
				`UPDATE users
				 SET username = ?, email = ?, email_verified_at = ?, guest_expires_at = NULL,
				     display_name = COALESCE(?, display_name), updated_at = ?
				 WHERE id = ? AND guest_expires_at IS NOT NULL AND deleted_at IS NULL`,
			)
			.bind(
				username,
				input.email,
				now,
				input.displayName ?? null,
				now,
				user.id,
			),
		db
			.prepare(
				`UPDATE orgs
				 SET slug = ?, display_name = COALESCE(?, display_name), profile_visibility = 'public',
				     signup_welcome_credits_pending = 1, updated_at = ?
				 WHERE id = ? AND deleted_at IS NULL`,
			)
			.bind(username, input.displayName ?? null, now, orgId),
		db
			.prepare(`UPDATE handles SET handle = ? WHERE handle = ? AND org_id = ?`)
			.bind(username, user.username, orgId),
		...guestConversionStatements(db, {
			personId: guest.personId,
			orgId,
			now,
		}),
	]
	await db.batch(statements)
	await maybeGrantSignupWelcomeCredits({ db, userId: orgId })
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'guest_account_claimed',
		result: 'success',
		email: input.email,
		reason: `mode=new;phase=${guestPhase(guest.expiresAt)}`,
	})
	scheduleGuestClaimedEvent({
		env,
		mode: 'new',
		method: input.method ?? 'agent',
		provider: input.provider ?? null,
		user: { id: guest.personId, username, email: input.email },
		guest: guestClaimedSnapshot(guest, user, claimDate),
		claimedAt: now,
		counts,
		renamedPackages: 0,
	})
	return {
		mode: 'new',
		username,
		personId: guest.personId,
		personalOrgId: orgId,
		renamedPackages: [],
	}
}

async function renameClashingPackages(
	db: D1Database,
	fromOrgId: string,
	toOrgId: string,
) {
	const clashes = await db
		.prepare(
			`SELECT id, kody_id FROM saved_packages
			 WHERE user_id = ? AND deleted_at IS NULL
			   AND kody_id IN (SELECT kody_id FROM saved_packages WHERE user_id = ? AND deleted_at IS NULL)`,
		)
		.bind(fromOrgId, toOrgId)
		.all<{ id: string; kody_id: string }>()
	const renamed: Array<{ from: string; to: string }> = []
	for (const row of clashes.results ?? []) {
		for (let attempt = 1; attempt < 50; attempt++) {
			const candidate =
				attempt === 1
					? `${row.kody_id}-guest`
					: `${row.kody_id}-guest-${attempt}`
			const taken = await db
				.prepare(
					`SELECT 1 AS present FROM saved_packages
					 WHERE kody_id = ? AND user_id IN (?, ?) AND deleted_at IS NULL`,
				)
				.bind(candidate, fromOrgId, toOrgId)
				.first<{ present: number }>()
			if (taken) continue
			await db
				.prepare(
					`UPDATE saved_packages SET kody_id = ? WHERE id = ? AND deleted_at IS NULL`,
				)
				.bind(candidate, row.id)
				.run()
			renamed.push({ from: row.kody_id, to: candidate })
			break
		}
	}
	return renamed
}

async function moveMemories(env: Env, fromOrgId: string, toOrgId: string) {
	const db = env.APP_DB
	const rows = await db
		.prepare(
			`SELECT * FROM mcp_memories WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(fromOrgId)
		.all<McpMemoryRow>()
	await db.batch([
		db
			.prepare(
				`UPDATE mcp_memories SET user_id = ? WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(toOrgId, fromOrgId),
		db
			.prepare(
				`UPDATE mcp_memory_conversation_suppressions SET user_id = ? WHERE user_id = ?`,
			)
			.bind(toOrgId, fromOrgId),
	])
	for (const row of rows.results ?? []) {
		try {
			await deleteMemoryVector(env, row.id)
			await upsertMemoryVector(env, {
				memoryId: row.id,
				userId: toOrgId as never,
				category: row.category,
				status: row.status,
				embedText: buildMemoryEmbedTextFromRow(row),
			})
		} catch (error) {
			console.warn('guest-claim-memory-vector-move-failed', error)
		}
	}
	return rows.results?.length ?? 0
}

async function moveRunHistory(env: Env, fromOrgId: string, toOrgId: string) {
	const from = runLogRpc({ env, userId: fromOrgId as never })
	const to = runLogRpc({ env, userId: toOrgId as never })
	let afterId: string | null = null
	let moved = 0
	for (let page = 0; page < 400; page++) {
		const batch = await from.exportRunHistoryPage({ afterId, limit: 50 })
		if (batch.runs.length > 0) {
			moved += (await to.importRunHistory(batch)).imported
		}
		if (!batch.nextAfterId) break
		afterId = batch.nextAfterId
	}
	return moved
}

/**
 * Claim into an existing account: move the guest's work into that account's
 * personal org, then delete the empty guest. The guest's OAuth grants stay
 * and resolve to the claiming person through the guest alias.
 */
export async function mergeGuestIntoAccount(
	input: {
		env: Env
		guest: GuestAccount
		target: GuestClaimTarget
		baseUrl: string
		now?: Date
	} & GuestClaimVia,
): Promise<GuestClaimResult> {
	const { env, guest, target } = input
	const db = env.APP_DB
	const countsPromise = guestClaimCounts(env, guest)
	const user = await readClaimableGuestUser(db, guest)
	const counts = await countsPromise
	const fromOrgId = guest.personalOrgId
	const toOrgId = target.personalOrgId
	const renamedPackages = await renameClashingPackages(db, fromOrgId, toOrgId)
	await db
		.prepare(
			`UPDATE enablements SET enabler_user_id = ? WHERE enabler_user_id = ?`,
		)
		.bind(target.personId, guest.personId)
		.run()
	const transfer = await runOrgResourceTransfer({
		db,
		effects: defaultOrgTransferEffects({
			env,
			baseUrl: input.baseUrl,
			actor: { userId: target.personId, username: target.username },
		}),
		actorUserId: target.personId,
		fromOrgId,
		toOrgId,
		mode: 'apply',
		skipOrphans: true,
	})
	if (transfer.outcome === 'refused' || transfer.outcome === 'failed') {
		console.error('guest-claim-merge-transfer-blocked', {
			outcome: transfer.outcome,
			refusals: transfer.refusals.map((finding) => finding.code),
			failedStep: transfer.failure?.failed_step ?? null,
		})
		throw new GuestClaimError(
			'merge_blocked',
			'Kody could not move this guest account into that account. Nothing was changed. Try again, or claim into a new account.',
		)
	}
	const leftovers = Object.entries(transfer.leftovers ?? {}).filter(
		([, count]) => count > 0,
	)
	if (leftovers.length > 0) {
		console.error('guest-claim-merge-transfer-leftovers', {
			kinds: leftovers.map(([kind]) => kind),
		})
		throw new GuestClaimError(
			'merge_blocked',
			'Kody moved part of this guest account but not all of it. Nothing was deleted. Try the claim again.',
		)
	}
	await moveMemories(env, fromOrgId, toOrgId)
	await moveRunHistory(env, fromOrgId, toOrgId).catch((error: unknown) => {
		console.error('guest-claim-run-history-move-failed', error)
		throw new GuestClaimError(
			'merge_blocked',
			'Kody could not move the run history yet. Nothing was deleted. Try the claim again.',
		)
	})
	const claimDate = input.now ?? new Date()
	const now = claimDate.toISOString()
	await db.batch([
		db
			.prepare(
				`UPDATE referrals SET referee_stable_user_id = ?
				 WHERE referee_stable_user_id = ?
				   AND NOT EXISTS (SELECT 1 FROM referrals WHERE referee_stable_user_id = ?)`,
			)
			.bind(target.personId, guest.personId, target.personId),
		db
			.prepare(
				`UPDATE referrals SET referrer_stable_user_id = ? WHERE referrer_stable_user_id = ?`,
			)
			.bind(target.personId, guest.personId),
		db
			.prepare(
				`UPDATE api_tokens SET user_id = ?, org_id = ?, updated_at = ?
				 WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(target.personId, toOrgId, now, guest.personId),
		...guestConversionStatements(db, {
			personId: guest.personId,
			orgId: fromOrgId,
			now,
			intoPersonId: target.personId,
			intoOrgId: toOrgId,
		}),
	])
	await deleteUserAccount({
		env,
		dbUserId: user.id,
		mcpUserId: fromOrgId as never,
		personUserId: guest.personId,
		keepOAuthGrants: true,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'guest_account_claimed',
		result: 'success',
		email: target.email,
		reason: `mode=merge;phase=${guestPhase(guest.expiresAt)};renamed=${renamedPackages.length}`,
	})
	scheduleGuestClaimedEvent({
		env,
		mode: 'merge',
		method: input.method ?? 'agent',
		provider: input.provider ?? null,
		user: {
			id: target.personId,
			username: target.username,
			email: target.email,
		},
		guest: guestClaimedSnapshot(guest, user, claimDate),
		claimedAt: now,
		counts,
		renamedPackages: renamedPackages.length,
	})
	return {
		mode: 'merge',
		username: target.username,
		personId: target.personId,
		personalOrgId: toOrgId,
		renamedPackages,
	}
}

function guestClaimedSnapshot(
	guest: GuestAccount,
	user: GuestUserRow,
	claimDate: Date,
) {
	return {
		id: guest.personId,
		username: user.username,
		clientName: guest.clientName,
		createdAt: guest.createdAt,
		expiresAt: guest.expiresAt,
		phase: guestPhase(guest.expiresAt, claimDate),
	}
}

export type GuestComesWith = Pick<
	GuestClaimCounts,
	'packages' | 'memories' | 'jobs' | 'runs'
>

async function countOr0(
	label: string,
	read: () => Promise<number>,
	options: { quiet?: boolean } = {},
) {
	try {
		return await read()
	} catch (error) {
		if (!options.quiet) {
			console.warn('guest-claim-count-failed', { kind: label, error })
		}
		return 0
	}
}

/**
 * What the guest personal org holds right now (non-deleted rows). Never
 * throws: a failed count reads as 0 so it cannot fail a claim.
 */
export async function guestClaimCounts(
	env: Env,
	guest: GuestAccount,
): Promise<GuestClaimCounts> {
	const db = env.APP_DB
	const orgId = guest.personalOrgId
	const count = (label: string, sql: string) =>
		countOr0(label, async () => {
			const row = await db.prepare(sql).bind(orgId).first<{ n: number }>()
			return Number(row?.n ?? 0)
		})
	const [
		packages,
		repos,
		memories,
		secrets,
		connections,
		mcpServers,
		apps,
		jobs,
		webhooks,
		runs,
	] = await Promise.all([
		count(
			'packages',
			`SELECT COUNT(*) AS n FROM saved_packages WHERE user_id = ? AND deleted_at IS NULL`,
		),
		count(
			'repos',
			`SELECT COUNT(*) AS n FROM user_repos WHERE user_id = ? AND deleted_at IS NULL`,
		),
		count(
			'memories',
			`SELECT COUNT(*) AS n FROM mcp_memories WHERE user_id = ? AND deleted_at IS NULL`,
		),
		count(
			'secrets',
			`SELECT COUNT(*) AS n FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE b.user_id = ? AND b.deleted_at IS NULL AND e.deleted_at IS NULL`,
		),
		count(
			'connections',
			`SELECT COUNT(*) AS n FROM user_integrations WHERE user_id = ? AND deleted_at IS NULL`,
		),
		count(
			'mcp_servers',
			`SELECT COUNT(*) AS n FROM mcp_server_settings WHERE user_id = ? AND deleted_at IS NULL`,
		),
		count(
			'apps',
			`SELECT COUNT(*) AS n FROM saved_packages WHERE user_id = ? AND deleted_at IS NULL AND has_app = 1`,
		),
		countOr0(
			'jobs',
			async () => {
				const { listJobs } = await import('#worker/jobs/inspect.ts')
				return (await listJobs({ env, userId: orgId as never })).length
			},
			{ quiet: true },
		),
		count(
			'webhooks',
			`SELECT COUNT(*) AS n FROM webhook_endpoints WHERE user_id = ? AND deleted_at IS NULL`,
		),
		countOr0(
			'runs',
			async () => runLogRpc({ env, userId: orgId as never }).countRunHistory(),
			{ quiet: true },
		),
	])
	return {
		packages,
		repos,
		memories,
		secrets,
		connections,
		mcp_servers: mcpServers,
		apps,
		jobs,
		webhooks,
		runs,
	}
}

/** What a claim carries over, for the "Comes with you" pills. */
export async function guestComesWithCounts(
	env: Env,
	guest: GuestAccount,
): Promise<GuestComesWith> {
	const { packages, memories, jobs, runs } = await guestClaimCounts(env, guest)
	return { packages, memories, jobs, runs }
}

export function guestClaimDonePath(
	claimCode: string,
	mode: 'new' | 'merge',
	comesWith: GuestComesWith,
) {
	const params = new URLSearchParams({ result: 'claimed', mode })
	for (const [key, value] of Object.entries(comesWith)) {
		if (value > 0) params.set(key, String(value))
	}
	return `/claim/${encodeURIComponent(claimCode)}?${params}`
}

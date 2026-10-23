import { CommunityForkInProgressError } from './errors.ts'

/**
 * DB-level guard that keeps community forks idempotent per (target owner,
 * listing). `community_fork_claims` has one row per pair; acquiring it is a
 * single upsert that only wins when no live claim exists, so two concurrent
 * fork requests (double submit, a retry after navigating away, an agent and
 * the web UI at once) cannot both create a fork.
 */

/** A crashed request releases its claim after this long. */
const communityForkClaimLeaseMs = 5 * 60_000
/** How long a second request waits for an in-flight fork before giving up. */
const communityForkClaimWaitMs = 25_000
const communityForkClaimPollMs = 750
/**
 * A live holder renews its lease this often, so a slow fork (Artifacts
 * fallback, waiting for a stale repo to clear) never outlives its claim and
 * lets a second request start the same fork. Only a crashed request stops
 * renewing.
 */
const communityForkClaimRenewMs = Math.floor(communityForkClaimLeaseMs / 5)

type CommunityForkClaim = {
	ownerId: string
	listingId: string
	claimId: string
	requestedKodyId: string | null
	startedAt: string
	expiresAt: string
}

type ClaimRow = {
	owner_id: string
	listing_id: string
	claim_id: string
	requested_kody_id: string | null
	started_at: string
	expires_at: string
}

function mapClaimRow(row: ClaimRow): CommunityForkClaim {
	return {
		ownerId: row.owner_id,
		listingId: row.listing_id,
		claimId: row.claim_id,
		requestedKodyId: row.requested_kody_id,
		startedAt: row.started_at,
		expiresAt: row.expires_at,
	}
}

/**
 * Take the claim for this owner and listing. Returns the claim id when this
 * caller now holds it, or null while another live claim exists. An expired
 * claim is taken over in the same statement.
 */
export async function acquireCommunityForkClaim(
	db: D1Database,
	input: {
		ownerId: string
		listingId: string
		requestedKodyId?: string | null
		now?: Date
		leaseMs?: number
	},
): Promise<string | null> {
	const now = input.now ?? new Date()
	const startedAt = now.toISOString()
	const expiresAt = new Date(
		now.getTime() + (input.leaseMs ?? communityForkClaimLeaseMs),
	).toISOString()
	const claimId = crypto.randomUUID()
	const row = await db
		.prepare(
			`INSERT INTO community_fork_claims (
				owner_id, listing_id, claim_id, requested_kody_id, started_at,
				expires_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(owner_id, listing_id) DO UPDATE SET
				claim_id = excluded.claim_id,
				requested_kody_id = excluded.requested_kody_id,
				started_at = excluded.started_at,
				expires_at = excluded.expires_at
			WHERE community_fork_claims.expires_at <= excluded.started_at
			RETURNING claim_id`,
		)
		.bind(
			input.ownerId,
			input.listingId,
			claimId,
			input.requestedKodyId ?? null,
			startedAt,
			expiresAt,
		)
		.first<{ claim_id: string }>()
	return row?.claim_id === claimId ? claimId : null
}

export async function releaseCommunityForkClaim(
	db: D1Database,
	input: { ownerId: string; listingId: string; claimId: string },
) {
	await db
		.prepare(
			`DELETE FROM community_fork_claims
			WHERE owner_id = ? AND listing_id = ? AND claim_id = ?`,
		)
		.bind(input.ownerId, input.listingId, input.claimId)
		.run()
}

/**
 * Push this holder's lease out again. Returns false when the claim is no
 * longer held by `claimId` (released, or expired and taken over).
 */
export async function renewCommunityForkClaim(
	db: D1Database,
	input: {
		ownerId: string
		listingId: string
		claimId: string
		now?: Date
		leaseMs?: number
	},
): Promise<boolean> {
	const now = input.now ?? new Date()
	const expiresAt = new Date(
		now.getTime() + (input.leaseMs ?? communityForkClaimLeaseMs),
	).toISOString()
	const row = await db
		.prepare(
			`UPDATE community_fork_claims SET expires_at = ?
			WHERE owner_id = ? AND listing_id = ? AND claim_id = ?
			RETURNING claim_id`,
		)
		.bind(expiresAt, input.ownerId, input.listingId, input.claimId)
		.first<{ claim_id: string }>()
	return row?.claim_id === input.claimId
}

/** Live (unexpired) claims for a listing held by any of these owners. */
export async function getActiveCommunityForkClaim(
	db: D1Database,
	input: { ownerIds: Array<string>; listingId: string; now?: Date },
): Promise<CommunityForkClaim | null> {
	const ownerIds = [...new Set(input.ownerIds)].filter(Boolean)
	if (ownerIds.length === 0) return null
	const placeholders = ownerIds.map(() => '?').join(', ')
	const row = await db
		.prepare(
			`SELECT owner_id, listing_id, claim_id, requested_kody_id,
				started_at, expires_at
			FROM community_fork_claims
			WHERE listing_id = ? AND owner_id IN (${placeholders})
				AND expires_at > ?
			ORDER BY started_at DESC
			LIMIT 1`,
		)
		.bind(input.listingId, ...ownerIds, (input.now ?? new Date()).toISOString())
		.first<ClaimRow>()
	return row ? mapClaimRow(row) : null
}

/**
 * Run `work` while holding the (owner, listing) claim. When another request
 * holds it, poll until that fork finishes (then run `work`, which should find
 * and return the finished fork) or the wait budget runs out.
 */
export async function withCommunityForkClaim<T>(
	input: {
		db: D1Database
		ownerId: string
		listingId: string
		requestedKodyId?: string | null
		waitMs?: number
		pollMs?: number
		renewMs?: number
		sleep?: (ms: number) => Promise<void>
		onWaiting?: (claim: CommunityForkClaim | null) => void | Promise<void>
	},
	work: () => Promise<T>,
): Promise<T> {
	const waitMs = input.waitMs ?? communityForkClaimWaitMs
	const pollMs = input.pollMs ?? communityForkClaimPollMs
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const deadline = Date.now() + waitMs
	let notified = false
	for (;;) {
		const claimId = await acquireCommunityForkClaim(input.db, {
			ownerId: input.ownerId,
			listingId: input.listingId,
			requestedKodyId: input.requestedKodyId,
		})
		if (claimId) {
			const claimKey = {
				ownerId: input.ownerId,
				listingId: input.listingId,
				claimId,
			}
			const renewal = setInterval(() => {
				void renewCommunityForkClaim(input.db, claimKey)
					.then((held) => {
						if (!held) {
							console.error(
								'community fork claim lost before the fork finished',
							)
						}
					})
					.catch((error: unknown) => {
						console.error('community fork claim renewal failed', error)
					})
			}, input.renewMs ?? communityForkClaimRenewMs)
			try {
				return await work()
			} finally {
				clearInterval(renewal)
				try {
					await releaseCommunityForkClaim(input.db, {
						ownerId: input.ownerId,
						listingId: input.listingId,
						claimId,
					})
				} catch (error) {
					// The lease still expires; a failed release only delays the
					// next fork of this listing, it never duplicates one.
					console.error('community fork claim release failed', error)
				}
			}
		}
		const holder = await getActiveCommunityForkClaim(input.db, {
			ownerIds: [input.ownerId],
			listingId: input.listingId,
		})
		if (!notified) {
			notified = true
			await input.onWaiting?.(holder)
		}
		if (Date.now() >= deadline) {
			throw new CommunityForkInProgressError(holder?.startedAt ?? null)
		}
		await sleep(pollMs)
	}
}

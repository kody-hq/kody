import { waitUntil } from 'cloudflare:workers'

/**
 * Refusal log for calls that asked for a package-locked user credential
 * without coming through a package-bound handle (see
 * `assertPackageCanAccessResolvedSecret`). Rows are deduped per UTC day and
 * never hold credential values. They exist so an attribution bug (a call that
 * did go through the locked package's code but arrived unbound) shows up
 * quickly.
 */
export type UnboundUseSurface = 'hosted' | 'app'
/** The shared channel the call arrived on. */
export type UnboundUsePattern = 'shared_fetch' | 'shared_capability'
export type UnboundUseKind = 'ad_hoc' | 'run_package_unbound'

export type UnboundUseRefusal = {
	ownerId: string
	credentialId: string
	credentialName: string
	surface: UnboundUseSurface
	pattern: UnboundUsePattern
	/** The run's own package, or null for ad hoc code. */
	runPackageId: string | null
}

export const unboundUseRefusalFlushDelayMs = 1_000

type PendingRefusal = {
	day: string
	ownerId: string
	credentialId: string
	kind: UnboundUseKind
	surface: UnboundUseSurface
	pattern: UnboundUsePattern
	runPackageId: string
	credentialName: string
	firstSeenAt: string
	lastSeenAt: string
	observations: number
}

const pendingByDb = new WeakMap<D1Database, Map<string, PendingRefusal>>()
const flushScheduled = new WeakSet<D1Database>()

function buildUpsert(db: D1Database, row: PendingRefusal) {
	return db
		.prepare(
			`INSERT INTO credential_unbound_use_refusals (
				day, owner_id, credential_id, kind, surface, pattern, run_package_id,
				credential_name, first_seen_at, last_seen_at, observations
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, owner_id, credential_id, kind, surface, pattern, run_package_id) DO UPDATE SET
				credential_name = excluded.credential_name,
				first_seen_at = min(credential_unbound_use_refusals.first_seen_at, excluded.first_seen_at),
				last_seen_at = max(credential_unbound_use_refusals.last_seen_at, excluded.last_seen_at),
				observations = credential_unbound_use_refusals.observations + excluded.observations`,
		)
		.bind(
			row.day,
			row.ownerId,
			row.credentialId,
			row.kind,
			row.surface,
			row.pattern,
			row.runPackageId,
			row.credentialName,
			row.firstSeenAt,
			row.lastSeenAt,
			row.observations,
		)
}

async function flushPending(db: D1Database, delayMs: number) {
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
	flushScheduled.delete(db)
	const pending = pendingByDb.get(db)
	if (!pending || pending.size === 0) return
	const rows = [...pending.values()]
	pending.clear()
	try {
		await db.batch(rows.map((row) => buildUpsert(db, row)))
	} catch (error) {
		console.error('credential-unbound-use-refusal-record-failed', {
			rows: rows.length,
			credentialId: rows[0]?.credentialId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/** Never throws and never delays the refusal it records. */
export function scheduleUnboundUseRefusal(input: {
	env: Pick<Env, 'APP_DB'>
	refusal: UnboundUseRefusal
	now?: string
	flushDelayMs?: number
}): void {
	try {
		const db = input.env.APP_DB
		const ownerId = input.refusal.ownerId.trim()
		const credentialId = input.refusal.credentialId.trim()
		if (!db || !ownerId || !credentialId) return
		const runPackageId = input.refusal.runPackageId?.trim() ?? ''
		const kind: UnboundUseKind = runPackageId ? 'run_package_unbound' : 'ad_hoc'
		const { surface, pattern } = input.refusal
		const now = input.now ?? new Date().toISOString()
		const day = now.slice(0, 10)
		const key = [
			day,
			ownerId,
			credentialId,
			kind,
			surface,
			pattern,
			runPackageId,
		].join('\0')
		let pending = pendingByDb.get(db)
		if (!pending) {
			pending = new Map()
			pendingByDb.set(db, pending)
		}
		const existing = pending.get(key)
		if (existing) {
			existing.observations += 1
			if (now > existing.lastSeenAt) existing.lastSeenAt = now
			return
		}
		pending.set(key, {
			day,
			ownerId,
			credentialId,
			kind,
			surface,
			pattern,
			runPackageId,
			credentialName: input.refusal.credentialName,
			firstSeenAt: now,
			lastSeenAt: now,
			observations: 1,
		})
		if (flushScheduled.has(db)) return
		flushScheduled.add(db)
		waitUntil(
			flushPending(db, input.flushDelayMs ?? unboundUseRefusalFlushDelayMs),
		)
	} catch (error) {
		console.error('credential-unbound-use-refusal-schedule-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

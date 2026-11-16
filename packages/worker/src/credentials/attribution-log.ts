import { waitUntil } from 'cloudflare:workers'

/**
 * Credential attribution log. Two kinds of row, neither holding credential
 * values. Refusals: calls that asked for a package-locked user credential
 * without coming through a package-bound handle (see
 * `assertPackageCanAccessResolvedSecret`). Rows are deduped per UTC day and
 * never hold credential values. They exist so an attribution bug (a call that
 * did go through the locked package's code but arrived unbound) shows up
 * quickly. Changed intrinsics (`intrinsics_changed`): a package on the list
 * used the credential through its own bound fetch in a run where shared
 * globals had been replaced, which is allowed and recorded so the practice
 * can be measured before it is restricted.
 */
export type UnboundUseSurface = 'hosted' | 'app'
/** The shared channel the call arrived on. */
export type UnboundUsePattern = 'shared_fetch' | 'shared_capability'
/**
 * `listed_package_unbound`: a package on the credential's list is part of the
 * run, so the call may be that package's own code reaching the network
 * through a channel the bundler could not bind (usually an older bundle).
 */
export type UnboundUseKind =
	| 'ad_hoc'
	| 'run_package_unbound'
	| 'listed_package_unbound'
type RecordKind = UnboundUseKind | 'intrinsics_changed'
type RecordPattern = UnboundUsePattern | 'bound_fetch'

export type UnboundUseRefusal = {
	ownerId: string
	credentialId: string
	credentialName: string
	surface: UnboundUseSurface
	pattern: UnboundUsePattern
	/** The run's own package, or null for ad hoc code. */
	runPackageId: string | null
	/** A package on the credential's list that is loaded in the run, if any. */
	listedPackageIdInRun?: string | null
}

export const unboundUseRefusalFlushDelayMs = 1_000

type PendingRefusal = {
	day: string
	ownerId: string
	credentialId: string
	kind: RecordKind
	surface: UnboundUseSurface
	pattern: RecordPattern
	runPackageId: string
	boundPackageId: string
	changedIntrinsics: string
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
			`INSERT INTO credential_attribution_log (
				day, owner_id, credential_id, kind, surface, pattern, run_package_id,
				bound_package_id, changed_intrinsics, credential_name, first_seen_at,
				last_seen_at, observations
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, owner_id, credential_id, kind, surface, pattern, run_package_id, bound_package_id, changed_intrinsics) DO UPDATE SET
				credential_name = excluded.credential_name,
				first_seen_at = min(credential_attribution_log.first_seen_at, excluded.first_seen_at),
				last_seen_at = max(credential_attribution_log.last_seen_at, excluded.last_seen_at),
				observations = credential_attribution_log.observations + excluded.observations`,
		)
		.bind(
			row.day,
			row.ownerId,
			row.credentialId,
			row.kind,
			row.surface,
			row.pattern,
			row.runPackageId,
			row.boundPackageId,
			row.changedIntrinsics,
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

function enqueue(input: {
	env: Pick<Env, 'APP_DB'>
	row: Omit<
		PendingRefusal,
		'day' | 'firstSeenAt' | 'lastSeenAt' | 'observations'
	>
	now?: string
	flushDelayMs?: number
}): void {
	try {
		const db = input.env.APP_DB
		const row = input.row
		if (!db || !row.ownerId || !row.credentialId) return
		const now = input.now ?? new Date().toISOString()
		const day = now.slice(0, 10)
		const key = [
			day,
			row.ownerId,
			row.credentialId,
			row.kind,
			row.surface,
			row.pattern,
			row.runPackageId,
			row.boundPackageId,
			row.changedIntrinsics,
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
			...row,
			day,
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

/** Never throws and never delays the refusal it records. */
export function scheduleUnboundUseRefusal(input: {
	env: Pick<Env, 'APP_DB'>
	refusal: UnboundUseRefusal
	now?: string
	flushDelayMs?: number
}): void {
	const runPackageId = input.refusal.runPackageId?.trim() ?? ''
	const listedPackageId = input.refusal.listedPackageIdInRun?.trim() ?? ''
	enqueue({
		env: input.env,
		now: input.now,
		flushDelayMs: input.flushDelayMs,
		row: {
			ownerId: input.refusal.ownerId.trim(),
			credentialId: input.refusal.credentialId.trim(),
			kind: listedPackageId
				? 'listed_package_unbound'
				: runPackageId
					? 'run_package_unbound'
					: 'ad_hoc',
			surface: input.refusal.surface,
			pattern: input.refusal.pattern,
			runPackageId,
			boundPackageId: listedPackageId,
			changedIntrinsics: '',
			credentialName: input.refusal.credentialName,
		},
	})
}

/**
 * A locked credential was used by a listed package's bound fetch while shared
 * globals were changed. Recorded only; the use goes ahead.
 */
export function scheduleChangedIntrinsicsUse(input: {
	env: Pick<Env, 'APP_DB'>
	use: {
		ownerId: string
		credentialId: string
		credentialName: string
		surface: UnboundUseSurface
		runPackageId: string | null
		boundPackageId: string
		changedIntrinsics: ReadonlyArray<string>
	}
	now?: string
	flushDelayMs?: number
}): void {
	enqueue({
		env: input.env,
		now: input.now,
		flushDelayMs: input.flushDelayMs,
		row: {
			ownerId: input.use.ownerId.trim(),
			credentialId: input.use.credentialId.trim(),
			kind: 'intrinsics_changed',
			surface: input.use.surface,
			pattern: 'bound_fetch',
			runPackageId: input.use.runPackageId?.trim() ?? '',
			boundPackageId: input.use.boundPackageId,
			changedIntrinsics: input.use.changedIntrinsics.join(','),
			credentialName: input.use.credentialName,
		},
	})
}

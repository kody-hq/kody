/**
 * Observe-mode markers for issue #4129: a self-authored or adopted package used
 * a user credential whose `allowed_packages` list is non-empty and does not
 * include it. Runtime access is unchanged (still allowed); these rows measure
 * how many owners, credentials, and packages enforcement would affect.
 *
 * Hot path cost: `scheduleAllowedPackagesWouldBlock` never awaits D1. Calls for
 * the same day + owner + credential + package inside one isolate coalesce into
 * one deduped upsert, and every pending marker flushes in one `db.batch()`
 * through `waitUntil`. Never stores values.
 */
import { waitUntil } from 'cloudflare:workers'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type AllowedPackagesWouldBlockAccessKind = 'self_authored' | 'adopted'

export type AllowedPackagesWouldBlockMarker = {
	ownerId: string
	credentialId: string
	packageId: string
	accessKind: AllowedPackagesWouldBlockAccessKind
}

/** Coalescing window for repeated markers in one isolate (ms). */
export const allowedPackagesWouldBlockFlushDelayMs = 1_000

type PendingMarker = AllowedPackagesWouldBlockMarker & {
	day: string
	firstSeenAt: string
	lastSeenAt: string
	observations: number
}

const pendingByDb = new WeakMap<D1Database, Map<string, PendingMarker>>()
const flushScheduled = new WeakSet<D1Database>()

function utcDay(iso: string) {
	return iso.slice(0, 10)
}

export async function recordAllowedPackagesWouldBlock(input: {
	db: D1Database
	marker: AllowedPackagesWouldBlockMarker
	firstSeenAt: string
	lastSeenAt?: string
	observations?: number
}): Promise<void> {
	const ownerId = input.marker.ownerId.trim()
	const credentialId = input.marker.credentialId.trim()
	const packageId = input.marker.packageId.trim()
	if (!ownerId || !credentialId || !packageId) return
	await buildWouldBlockUpsert({
		db: input.db,
		marker: { ...input.marker, ownerId, credentialId, packageId },
		firstSeenAt: input.firstSeenAt,
		lastSeenAt: input.lastSeenAt,
		observations: input.observations,
	}).run()
}

function buildWouldBlockUpsert(input: {
	db: D1Database
	marker: AllowedPackagesWouldBlockMarker
	firstSeenAt: string
	lastSeenAt?: string
	observations?: number
}) {
	const lastSeenAt = input.lastSeenAt ?? input.firstSeenAt
	const observations = Math.max(1, Math.trunc(input.observations ?? 1))
	return input.db
		.prepare(
			`INSERT INTO credential_allowed_packages_would_block (
				day, owner_id, credential_id, package_id, access_kind,
				first_seen_at, last_seen_at, observations
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, owner_id, credential_id, package_id) DO UPDATE SET
				access_kind = excluded.access_kind,
				first_seen_at = min(credential_allowed_packages_would_block.first_seen_at, excluded.first_seen_at),
				last_seen_at = max(credential_allowed_packages_would_block.last_seen_at, excluded.last_seen_at),
				observations = credential_allowed_packages_would_block.observations + excluded.observations`,
		)
		.bind(
			utcDay(input.firstSeenAt),
			input.marker.ownerId,
			input.marker.credentialId,
			input.marker.packageId,
			input.marker.accessKind,
			input.firstSeenAt,
			lastSeenAt,
			observations,
		)
}

async function flushPendingMarkers(db: D1Database, delayMs: number) {
	// Always yield at least one macrotask so same-tick repeats coalesce.
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
	flushScheduled.delete(db)
	const pending = pendingByDb.get(db)
	if (!pending || pending.size === 0) return
	const markers = [...pending.values()]
	pending.clear()
	try {
		await db.batch(
			markers.map((marker) =>
				buildWouldBlockUpsert({
					db,
					marker,
					firstSeenAt: marker.firstSeenAt,
					lastSeenAt: marker.lastSeenAt,
					observations: marker.observations,
				}),
			),
		)
	} catch (error) {
		console.error('credential-allowed-packages-would-block-record-failed', {
			markers: markers.length,
			credentialId: markers[0]?.credentialId,
			packageId: markers[0]?.packageId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * Record a would-block marker after the response path. Synchronous, never
 * throws, and never awaits D1 on the caller's path.
 */
export function scheduleAllowedPackagesWouldBlock(input: {
	env: Pick<Env, 'APP_DB'>
	marker: AllowedPackagesWouldBlockMarker
	now?: string
	flushDelayMs?: number
}): void {
	try {
		const db = input.env.APP_DB
		const ownerId = input.marker.ownerId.trim()
		const credentialId = input.marker.credentialId.trim()
		const packageId = input.marker.packageId.trim()
		if (!db || !ownerId || !credentialId || !packageId) return
		const now = input.now ?? new Date().toISOString()
		const day = utcDay(now)
		const key = `${day}\0${ownerId}\0${credentialId}\0${packageId}`
		let pending = pendingByDb.get(db)
		if (!pending) {
			pending = new Map()
			pendingByDb.set(db, pending)
		}
		const existing = pending.get(key)
		if (existing) {
			existing.observations += 1
			if (now > existing.lastSeenAt) existing.lastSeenAt = now
			existing.accessKind = input.marker.accessKind
			return
		}
		pending.set(key, {
			ownerId,
			credentialId,
			packageId,
			accessKind: input.marker.accessKind,
			day,
			firstSeenAt: now,
			lastSeenAt: now,
			observations: 1,
		})
		if (flushScheduled.has(db)) return
		flushScheduled.add(db)
		waitUntil(
			flushPendingMarkers(
				db,
				input.flushDelayMs ?? allowedPackagesWouldBlockFlushDelayMs,
			),
		)
	} catch (error) {
		console.error('credential-allowed-packages-would-block-schedule-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export const allowedPackagesWouldBlockReportOwnerLimitMax = 500

export type AllowedPackagesWouldBlockReport = {
	since: string
	until: string | null
	totals: {
		owners: number
		credentials: number
		packages: number
		credentialPackagePairs: number
		selfAuthoredPackages: number
		adoptedPackages: number
		observations: number
	}
	ownersTruncated: boolean
	owners: Array<{
		ownerId: string
		ownerSlug: string | null
		credentials: number
		packages: number
		observations: number
		firstSeenAt: string
		lastSeenAt: string
		pairs: Array<{
			credentialId: string
			credentialName: string | null
			packageId: string
			packageKodyId: string | null
			accessKind: AllowedPackagesWouldBlockAccessKind
			days: number
			observations: number
			firstSeenAt: string
			lastSeenAt: string
		}>
	}>
}

type PairRow = {
	owner_id: string
	owner_slug: string | null
	credential_id: string
	credential_name: string | null
	package_id: string
	package_kody_id: string | null
	access_kind: AllowedPackagesWouldBlockAccessKind
	days: number
	observations: number
	first_seen_at: string
	last_seen_at: string
}

/**
 * Aggregate would-block markers for internal admin use. `since`/`until` are
 * UTC days (YYYY-MM-DD), inclusive / exclusive.
 */
export async function buildAllowedPackagesWouldBlockReport(input: {
	db: D1Database
	since: string
	until?: string | null
	ownerLimit?: number
}): Promise<AllowedPackagesWouldBlockReport> {
	const until = input.until ?? null
	const where = until ? 'w.day >= ? AND w.day < ?' : 'w.day >= ?'
	const binds = until ? [input.since, until] : [input.since]
	const totalsRow = await input.db
		.prepare(
			`SELECT
				COUNT(DISTINCT w.owner_id) AS owners,
				COUNT(DISTINCT w.credential_id) AS credentials,
				COUNT(DISTINCT w.package_id) AS packages,
				COUNT(DISTINCT w.credential_id || char(0) || w.package_id) AS pairs,
				COUNT(DISTINCT CASE WHEN w.access_kind = 'self_authored' THEN w.package_id END) AS self_authored,
				COUNT(DISTINCT CASE WHEN w.access_kind = 'adopted' THEN w.package_id END) AS adopted,
				COALESCE(SUM(w.observations), 0) AS observations
			 FROM credential_allowed_packages_would_block w
			 WHERE ${where}`,
		)
		.bind(...binds)
		.first<{
			owners: number
			credentials: number
			packages: number
			pairs: number
			self_authored: number
			adopted: number
			observations: number
		}>()
	const ownerLimit = Math.min(
		Math.max(1, Math.trunc(input.ownerLimit ?? 100)),
		allowedPackagesWouldBlockReportOwnerLimitMax,
	)
	const ownerIdsResult = await input.db
		.prepare(
			`SELECT w.owner_id AS owner_id, SUM(w.observations) AS observations
			 FROM credential_allowed_packages_would_block w
			 WHERE ${where}
			 GROUP BY w.owner_id
			 ORDER BY observations DESC, w.owner_id ASC
			 LIMIT ?`,
		)
		.bind(...binds, ownerLimit + 1)
		.all<{ owner_id: string; observations: number }>()
	const ownerIdRows = ownerIdsResult.results ?? []
	const ownersTruncated = ownerIdRows.length > ownerLimit
	const ownerIds = ownerIdRows.slice(0, ownerLimit).map((row) => row.owner_id)

	const owners: AllowedPackagesWouldBlockReport['owners'] = []
	for (const ownerId of ownerIds) {
		const pairsResult = await input.db
			.prepare(
				`SELECT
					w.owner_id AS owner_id,
					o.slug AS owner_slug,
					w.credential_id AS credential_id,
					s.name AS credential_name,
					w.package_id AS package_id,
					p.kody_id AS package_kody_id,
					MAX(w.access_kind) AS access_kind,
					COUNT(*) AS days,
					SUM(w.observations) AS observations,
					MIN(w.first_seen_at) AS first_seen_at,
					MAX(w.last_seen_at) AS last_seen_at
				 FROM credential_allowed_packages_would_block w
				 LEFT JOIN orgs o ON o.id = w.owner_id${andLiveDeletedAtSql('o')}
				 LEFT JOIN secret_entries s ON s.id = w.credential_id${andLiveDeletedAtSql('s')}
				 LEFT JOIN saved_packages p ON p.id = w.package_id${andLiveDeletedAtSql('p')}
				 WHERE w.owner_id = ? AND ${where}
				 GROUP BY w.owner_id, w.credential_id, w.package_id
				 ORDER BY observations DESC, w.credential_id ASC, w.package_id ASC`,
			)
			.bind(ownerId, ...binds)
			.all<PairRow>()
		const rows = pairsResult.results ?? []
		const [first] = rows
		if (!first) continue
		const credentials = new Set(rows.map((row) => row.credential_id))
		const packages = new Set(rows.map((row) => row.package_id))
		owners.push({
			ownerId,
			ownerSlug: first.owner_slug ?? null,
			credentials: credentials.size,
			packages: packages.size,
			observations: rows.reduce(
				(sum, row) => sum + Number(row.observations),
				0,
			),
			firstSeenAt: rows.reduce(
				(min, row) => (row.first_seen_at < min ? row.first_seen_at : min),
				first.first_seen_at,
			),
			lastSeenAt: rows.reduce(
				(max, row) => (row.last_seen_at > max ? row.last_seen_at : max),
				first.last_seen_at,
			),
			pairs: rows.map((row) => ({
				credentialId: row.credential_id,
				credentialName: row.credential_name ?? null,
				packageId: row.package_id,
				packageKodyId: row.package_kody_id ?? null,
				accessKind: row.access_kind,
				days: Number(row.days),
				observations: Number(row.observations),
				firstSeenAt: row.first_seen_at,
				lastSeenAt: row.last_seen_at,
			})),
		})
	}

	return {
		since: input.since,
		until,
		totals: {
			owners: Number(totalsRow?.owners ?? 0),
			credentials: Number(totalsRow?.credentials ?? 0),
			packages: Number(totalsRow?.packages ?? 0),
			credentialPackagePairs: Number(totalsRow?.pairs ?? 0),
			selfAuthoredPackages: Number(totalsRow?.self_authored ?? 0),
			adoptedPackages: Number(totalsRow?.adopted ?? 0),
			observations: Number(totalsRow?.observations ?? 0),
		},
		ownersTruncated,
		owners,
	}
}

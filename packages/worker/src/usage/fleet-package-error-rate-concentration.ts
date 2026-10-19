import { chunkArray } from '@kody-internal/shared/chunk.ts'
import {
	classifyFleetPackageErrorRateConcentrationKind,
	fleetPackageErrorRateFewAccountLimit,
	fleetPackageErrorRateMaxNamedOwners,
	fleetPackageErrorRateMaxNamedPackages,
	isFleetPackageErrorRateConcentrationKind,
	type FleetPackageErrorRateConcentration,
} from '#universal/fleet-package-error-rate-concentration.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { queryAnalyticsEngineSql } from './aggregate-rollups.ts'
import { fleetPackageErrorRateMetrics } from './fleet-package-error-rate-subscription-event.ts'

const maxSqlBindingsPerChunk = 90
const maxRankedOwners = 50
const analyticsEngineIdPattern = /^[A-Za-z0-9:._-]+$/

export type FleetPackageErrorRateConcentrationRow = {
	user_id?: string
	entity_id?: string
	error_count?: number | string
}

export type FleetPackageErrorRateConcentrationQueryEnv = {
	APP_DB?: D1Database
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
}

type RankedOwner = {
	ownerId: string
	errors: number
	entityIds: Array<string>
}

export function buildFleetPackageErrorRateConcentrationQuery(input: {
	dataset: string
	recentStart: Date
	recentEnd: Date
}) {
	return `
SELECT
	blob1 AS user_id,
	sum(_sample_interval) AS error_count
FROM ${input.dataset}
WHERE ${concentrationWhereClause(input)}
GROUP BY user_id
ORDER BY error_count DESC
LIMIT ${maxRankedOwners}
FORMAT JSON
`.trim()
}

export function buildFleetPackageErrorRateConcentrationPackageQuery(input: {
	dataset: string
	recentStart: Date
	recentEnd: Date
	ownerIds: ReadonlyArray<string>
}) {
	const ownerList = input.ownerIds
		.filter((ownerId) => analyticsEngineIdPattern.test(ownerId))
		.map((ownerId) => `'${ownerId}'`)
		.join(', ')
	if (ownerList.length === 0) return null
	return `
SELECT
	blob1 AS user_id,
	blob3 AS entity_id,
	sum(_sample_interval) AS error_count
FROM ${input.dataset}
WHERE ${concentrationWhereClause(input)}
	AND blob1 IN (${ownerList})
GROUP BY user_id, entity_id
ORDER BY error_count DESC
LIMIT ${fleetPackageErrorRateMaxNamedPackages}
FORMAT JSON
`.trim()
}

/**
 * Rank owners from the owner-only AE rows. Shares use the anonymous
 * window error total so a truncated owner sample cannot inflate
 * `one_account` / `few_accounts`.
 */
export function foldFleetPackageErrorRateConcentrationRows(
	rows: ReadonlyArray<FleetPackageErrorRateConcentrationRow>,
	recentErrors: number,
) {
	const windowErrors = Math.max(0, Math.round(recentErrors))
	const errorsByOwner = new Map<
		string,
		{ errors: number; entityIds: Map<string, number> }
	>()
	const packageIds = new Set<string>()
	for (const row of rows) {
		const ownerId = row.user_id?.trim() ?? ''
		if (ownerId.length === 0) continue
		const errors = Math.max(0, Math.round(Number(row.error_count ?? 0)))
		if (errors <= 0) continue
		const existing = errorsByOwner.get(ownerId) ?? {
			errors: 0,
			entityIds: new Map<string, number>(),
		}
		existing.errors += errors
		const entityId = row.entity_id?.trim() ?? ''
		if (entityId.length > 0) {
			existing.entityIds.set(
				entityId,
				(existing.entityIds.get(entityId) ?? 0) + errors,
			)
			packageIds.add(entityId)
		}
		errorsByOwner.set(ownerId, existing)
	}
	const ranked = [...errorsByOwner.entries()]
		.map(([ownerId, owner]) => ({
			ownerId,
			errors: owner.errors,
			entityIds: [...owner.entityIds.entries()]
				.sort((left, right) => right[1] - left[1])
				.map(([entityId]) => entityId),
		}))
		.sort((left, right) => right.errors - left.errors)
	const share = (errors: number) =>
		windowErrors === 0 ? 0 : Math.min(1, errors / windowErrors)
	return {
		recentErrors: windowErrors,
		ownerCount: ranked.length,
		packageCount: packageIds.size,
		topOwnerShare: share(ranked[0]?.errors ?? 0),
		topFewShare: share(
			ranked
				.slice(0, fleetPackageErrorRateFewAccountLimit)
				.reduce((sum, owner) => sum + owner.errors, 0),
		),
		ranked,
	}
}

export async function resolveFleetPackageErrorRateConcentration(input: {
	env: FleetPackageErrorRateConcentrationQueryEnv
	dataset: string
	recentStart: Date
	recentEnd: Date
	recentErrors: number
}): Promise<FleetPackageErrorRateConcentration | null> {
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	const windowErrors = Math.max(0, Math.round(input.recentErrors))
	if (windowErrors === 0) return null
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	let ownerRows: Array<FleetPackageErrorRateConcentrationRow>
	try {
		ownerRows =
			await queryAnalyticsEngineSql<FleetPackageErrorRateConcentrationRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetPackageErrorRateConcentrationQuery({
					dataset: input.dataset,
					recentStart: input.recentStart,
					recentEnd: input.recentEnd,
				}),
			})
	} catch (error) {
		console.warn('fleet-package-error-rate-concentration-query-failed', error)
		return null
	}
	const folded = foldFleetPackageErrorRateConcentrationRows(
		ownerRows,
		windowErrors,
	)
	if (folded.ranked.length === 0) return null
	const kind = classifyFleetPackageErrorRateConcentrationKind({
		topOwnerShare: folded.topOwnerShare,
		topFewShare: folded.topFewShare,
	})
	const namedOwners = folded.ranked.slice(
		0,
		fleetPackageErrorRateMaxNamedOwners,
	)
	if (kind !== 'fleet') {
		const packageRows = await loadOwnerPackageRows({
			accountId,
			apiToken,
			baseUrl,
			dataset: input.dataset,
			recentStart: input.recentStart,
			recentEnd: input.recentEnd,
			ownerIds: namedOwners.map((owner) => owner.ownerId),
		})
		attachOwnerPackages(namedOwners, packageRows)
		folded.packageCount = new Set(
			namedOwners.flatMap((owner) => owner.entityIds),
		).size
	}
	let named: FleetPackageErrorRateConcentration['owners'] = []
	if (kind !== 'fleet') {
		try {
			named = await resolveNamedOwners({
				db: input.env.APP_DB,
				owners: namedOwners,
				recentErrors: folded.recentErrors,
			})
		} catch (error) {
			console.warn('fleet-package-error-rate-concentration-names-failed', error)
		}
	}
	return {
		kind,
		recent_errors: folded.recentErrors,
		owner_count: folded.ownerCount,
		package_count: folded.packageCount,
		top_owner_share: folded.topOwnerShare,
		owners: named,
	}
}

export function parseFleetPackageErrorRateConcentration(
	value: unknown,
): FleetPackageErrorRateConcentration | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (
		typeof record.kind !== 'string' ||
		!isFleetPackageErrorRateConcentrationKind(record.kind) ||
		typeof record.recent_errors !== 'number' ||
		typeof record.owner_count !== 'number' ||
		typeof record.package_count !== 'number' ||
		typeof record.top_owner_share !== 'number' ||
		!Array.isArray(record.owners)
	) {
		return null
	}
	const owners: Array<FleetPackageErrorRateConcentration['owners'][number]> = []
	for (const entry of record.owners) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const owner = entry as Record<string, unknown>
		if (
			typeof owner.username !== 'string' ||
			owner.username.trim().length === 0 ||
			typeof owner.error_share !== 'number' ||
			!Array.isArray(owner.packages)
		) {
			continue
		}
		const packages: Array<{ kody_id: string }> = []
		for (const pkg of owner.packages) {
			if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) continue
			const row = pkg as Record<string, unknown>
			if (typeof row.kody_id === 'string' && row.kody_id.trim().length > 0) {
				packages.push({ kody_id: row.kody_id.trim() })
			}
		}
		owners.push({
			username: owner.username.trim(),
			error_share: owner.error_share,
			packages,
		})
	}
	return {
		kind: record.kind,
		recent_errors: record.recent_errors,
		owner_count: record.owner_count,
		package_count: record.package_count,
		top_owner_share: record.top_owner_share,
		owners,
	}
}

async function resolveNamedOwners(input: {
	db: D1Database | undefined
	owners: Array<RankedOwner>
	recentErrors: number
}): Promise<FleetPackageErrorRateConcentration['owners']> {
	if (!input.db || input.owners.length === 0) return []
	const usernames = await loadUsernames(
		input.db,
		input.owners.map((owner) => owner.ownerId),
	)
	const packageIds = input.owners.flatMap((owner) => owner.entityIds)
	const packages = await loadPackageKodyIds(input.db, packageIds)
	const named: FleetPackageErrorRateConcentration['owners'] = []
	for (const owner of input.owners) {
		const username = usernames.get(owner.ownerId)
		if (!username) continue
		named.push({
			username,
			error_share: Math.min(1, owner.errors / input.recentErrors),
			packages: owner.entityIds
				.map((entityId) => packages.get(entityId))
				.filter((kodyId): kodyId is string => kodyId != null)
				.slice(0, fleetPackageErrorRateMaxNamedPackages)
				.map((kody_id) => ({ kody_id })),
		})
	}
	return named
}

async function loadOwnerPackageRows(input: {
	accountId: string
	apiToken: string
	baseUrl: string
	dataset: string
	recentStart: Date
	recentEnd: Date
	ownerIds: ReadonlyArray<string>
}) {
	const rows: Array<FleetPackageErrorRateConcentrationRow> = []
	for (const ownerId of input.ownerIds) {
		const query = buildFleetPackageErrorRateConcentrationPackageQuery({
			...input,
			ownerIds: [ownerId],
		})
		if (!query) continue
		try {
			rows.push(
				...(await queryAnalyticsEngineSql<FleetPackageErrorRateConcentrationRow>(
					{
						accountId: input.accountId,
						apiToken: input.apiToken,
						baseUrl: input.baseUrl,
						query,
					},
				)),
			)
		} catch (error) {
			console.warn(
				'fleet-package-error-rate-concentration-packages-failed',
				error,
			)
		}
	}
	return rows
}

function attachOwnerPackages(
	owners: Array<RankedOwner>,
	rows: ReadonlyArray<FleetPackageErrorRateConcentrationRow>,
) {
	const entityIdsByOwner = new Map<string, Map<string, number>>()
	for (const row of rows) {
		const ownerId = row.user_id?.trim() ?? ''
		const entityId = row.entity_id?.trim() ?? ''
		const errors = Math.max(0, Math.round(Number(row.error_count ?? 0)))
		if (ownerId.length === 0 || entityId.length === 0 || errors <= 0) continue
		const existing = entityIdsByOwner.get(ownerId) ?? new Map<string, number>()
		existing.set(entityId, (existing.get(entityId) ?? 0) + errors)
		entityIdsByOwner.set(ownerId, existing)
	}
	for (const owner of owners) {
		const packages = entityIdsByOwner.get(owner.ownerId)
		if (!packages) continue
		owner.entityIds = [...packages.entries()]
			.sort((left, right) => right[1] - left[1])
			.map(([entityId]) => entityId)
	}
}

async function loadUsernames(db: D1Database, ownerIds: Array<string>) {
	const usernames = new Map<string, string>()
	for (const chunk of chunkArray(ownerIds, maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT stable_user_id, username
				FROM users
				WHERE deleting_at IS NULL${andLiveDeletedAtSql()}
					AND stable_user_id IN (${placeholders})`,
			)
			.bind(...chunk)
			.all<{ stable_user_id: string; username: string }>()
		for (const row of result.results ?? []) {
			const username = row.username.trim()
			if (username.length === 0) continue
			usernames.set(row.stable_user_id, username)
		}
	}
	return usernames
}

async function loadPackageKodyIds(db: D1Database, packageIds: Array<string>) {
	const kodyIds = new Map<string, string>()
	for (const chunk of chunkArray(packageIds, maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT id, kody_id
				FROM saved_packages
				WHERE id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ id: string; kody_id: string }>()
		for (const row of result.results ?? []) {
			const kodyId = row.kody_id.trim()
			if (kodyId.length === 0) continue
			kodyIds.set(row.id, kodyId)
		}
	}
	return kodyIds
}

function concentrationWhereClause(input: {
	recentStart: Date
	recentEnd: Date
}) {
	const metrics = fleetPackageErrorRateMetrics
		.map((metric) => `'${metric}'`)
		.join(', ')
	// Real failures only: `caught` static-call throws are excluded (same
	// filter as buildFleetPackageErrorRateAnalyticsQuery).
	return `timestamp >= toDateTime('${toAnalyticsDateTime(input.recentStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.recentEnd)}')
	AND blob2 IN (${metrics})
	AND blob4 = 'error'`
}

function toAnalyticsDateTime(date: Date) {
	return date.toISOString().slice(0, 19).replace('T', ' ')
}

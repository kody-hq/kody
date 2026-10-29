/**
 * Grandfathering for issue #4129: before self-authored and adopted packages
 * lose implicit use of a user credential whose non-empty `allowed_packages`
 * list leaves them out, add each package that uses one today to that list.
 *
 * Two sources find a pair:
 * - static: the literal user credential names the package's own published
 *   source reads (the same scan publish uses for the allowed-packages warning),
 *   joined against the runner's user credentials with a non-empty list that
 *   excludes the package. The runner is the package owner; a community fork
 *   counts only once adopted (an unadopted fork is already refused).
 * - log: `credential_allowed_packages_would_block` markers, which also catch
 *   names built at runtime that static analysis cannot resolve.
 *
 * Granting writes one `credential.allowed_packages_updated` audit row with the
 * reason and source. It never notifies the owner.
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { scanPackageCredentials } from '#worker/credentials/credential-inventory-scan.ts'
import {
	collectLiteralUserSecretNames,
	readDeclaredCredentialSlots,
} from '#worker/credentials/credential-allowed-packages-publish-warning.ts'
import { packageSourceFiles } from '#worker/credentials/credential-needs-closure.ts'
import {
	credentialAuditActions,
	credentialAuditEvent,
	listDelta,
} from '#worker/credentials/credential-audit.ts'
import { type AllowedPackagesWouldBlockAccessKind } from '#worker/credentials/allowed-packages-would-block.ts'
import { savedPackageImplicitUserSecretReadAccessKind } from '#mcp/secrets/package-access.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from '#mcp/secrets/allowed-packages.ts'
import {
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { listCandidatePackages } from '#worker/package-runtime/published-importable-artifact-backfill.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { loadPackageSourceRowForUser } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const allowedPackagesGrandfatherReason = 'grandfathered for #4129'

export type AllowedPackagesGrandfatherSource =
	| 'static'
	| 'log'
	| 'static+log'
	| 'safety_window'

export const allowedPackagesGrandfatherScanLimitDefault = 50
export const allowedPackagesGrandfatherScanLimitMax = 200

export type AllowedPackagesGrandfatherPair = {
	ownerId: string
	credentialId: string
	packageId: string
	accessKind: AllowedPackagesWouldBlockAccessKind
	source: Exclude<AllowedPackagesGrandfatherSource, 'safety_window'>
	/** Package source has names static analysis cannot resolve. */
	packageUnresolved: boolean
	logLastSeenAt: string | null
	logObservations: number
	outcome:
		| 'would_grant'
		| 'granted'
		| 'already_allowed'
		| 'missing'
		| 'conflict'
}

export type AllowedPackagesGrandfatherResult = {
	dryRun: boolean
	scannedPackages: number
	staticScannedPackages: number
	skippedUnpublished: number
	skippedNoSnapshot: number
	skippedUnadoptedFork: number
	/** Eligibility (adoption or publication) lookup failed; never granted. */
	skippedEligibilityUnknown: number
	unparsedPackages: number
	unresolvedPackages: number
	pairs: number
	staticPairs: number
	logPairs: number
	bothPairs: number
	staticOnlyPairs: number
	logOnlyPairs: number
	logOnlyUnresolvedPairs: number
	logOnlyAdoptedPairs: number
	owners: number
	credentials: number
	packages: number
	wouldGrant: number
	granted: number
	alreadyAllowed: number
	missing: number
	conflicts: number
	nextCursor: string | null
	details: Array<AllowedPackagesGrandfatherPair>
}

type ExcludingCredential = {
	id: string
	name: string
	allowedPackages: Array<string>
}

async function listExcludingUserCredentials(
	db: D1Database,
	ownerId: string,
): Promise<Array<ExcludingCredential>> {
	const result = await db
		.prepare(
			`SELECT e.id AS id, e.name AS name, e.allowed_packages AS allowed_packages
			 FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
			   AND e.id IS NOT NULL
			   AND COALESCE(e.kind, 'secret') = 'secret'
			   AND e.allowed_packages != '[]'${andLiveDeletedAtSql('e')}${andLiveDeletedAtSql('b')}`,
		)
		.bind(ownerId)
		.all<{ id: string; name: string; allowed_packages: string }>()
	return (result.results ?? [])
		.map((row) => ({
			id: row.id,
			name: row.name,
			allowedPackages: parseAllowedPackages(row.allowed_packages),
		}))
		.filter((row) => row.allowedPackages.length > 0)
}

type StaticPackageScan =
	| {
			status:
				| 'unpublished'
				| 'no_snapshot'
				| 'unadopted_fork'
				| 'eligibility_unknown'
	  }
	| {
			status: 'scanned'
			accessKind: AllowedPackagesWouldBlockAccessKind
			names: Array<string>
			unparsed: boolean
			unresolved: boolean
	  }

/** Literal user credential names the package's own published source reads. */
export async function scanPackageUserCredentialNames(input: {
	env: Env
	savedPackage: SavedPackageRecord
}): Promise<StaticPackageScan> {
	let accessKind: AllowedPackagesWouldBlockAccessKind | null
	let source: Awaited<ReturnType<typeof loadPackageSourceRowForUser>>
	try {
		accessKind = await savedPackageImplicitUserSecretReadAccessKind({
			db: input.env.APP_DB,
			userId: input.savedPackage.userId,
			savedPackage: input.savedPackage,
		})
		if (!accessKind) return { status: 'unadopted_fork' }
		source = await loadPackageSourceRowForUser({
			env: input.env,
			userId: input.savedPackage.userId,
			sourceId: input.savedPackage.sourceId,
		})
	} catch {
		// Current publication or adoption is unknown: never grant from a marker.
		return { status: 'eligibility_unknown' }
	}
	const publishedCommit = source.published_commit?.trim() || null
	if (!publishedCommit) return { status: 'unpublished' }
	const snapshot = await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit,
	})
	if (!snapshot) return { status: 'no_snapshot' }
	const files = packageSourceFiles({ source, files: snapshot.files }).files
	const scan = scanPackageCredentials({
		files,
		slots: readDeclaredCredentialSlots(files['package.json']),
	})
	return {
		status: 'scanned',
		accessKind,
		names: collectLiteralUserSecretNames(scan),
		unparsed: scan.unparsedModules > 0,
		unresolved: scan.placeholders.computed > 0 || scan.unparsedModules > 0,
	}
}

type LogPairRow = {
	owner_id: string
	credential_id: string
	package_id: string
	access_kind: AllowedPackagesWouldBlockAccessKind
	last_seen_at: string
	observations: number
}

const logPairPackageChunkSize = 90

async function listLogPairsForPackages(input: {
	db: D1Database
	packageIds: ReadonlyArray<string>
	since: string
	lastSeenAfter: string | null
}): Promise<Array<LogPairRow>> {
	if (input.packageIds.length === 0) return []
	// D1 allows 100 bound parameters per query; `since` takes one.
	const rows: Array<LogPairRow> = []
	for (
		let index = 0;
		index < input.packageIds.length;
		index += logPairPackageChunkSize
	) {
		const chunk = input.packageIds.slice(index, index + logPairPackageChunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await input.db
			.prepare(
				`SELECT w.owner_id AS owner_id, w.credential_id AS credential_id,
					w.package_id AS package_id, MAX(w.access_kind) AS access_kind,
					MAX(w.last_seen_at) AS last_seen_at, SUM(w.observations) AS observations
				 FROM credential_allowed_packages_would_block w
				 WHERE w.day >= ? AND w.package_id IN (${placeholders})
				 GROUP BY w.owner_id, w.credential_id, w.package_id`,
			)
			.bind(input.since, ...chunk)
			.all<LogPairRow>()
		rows.push(...(result.results ?? []))
	}
	return rows.filter(
		(row) => !input.lastSeenAfter || row.last_seen_at > input.lastSeenAfter,
	)
}

type GrantOutcome = 'granted' | 'already_allowed' | 'missing' | 'conflict'

/**
 * Add one package to a user credential's non-empty allowed list, guarded on
 * the list read so a concurrent edit is never overwritten. Audits with the
 * #4129 reason and source. Never notifies the owner.
 */
export async function grantGrandfatheredPackageAccess(input: {
	db: D1Database
	audit: OrgAuditWriter | null
	ownerId: string
	credentialId: string
	packageId: string
	source: AllowedPackagesGrandfatherSource
}): Promise<GrantOutcome> {
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.name AS name, e.allowed_packages AS allowed_packages
			 FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id = ? AND b.user_id = ? AND b.scope = 'user'${andLiveDeletedAtSql('e')}${andLiveDeletedAtSql('b')}`,
		)
		.bind(input.credentialId, input.ownerId)
		.first<{ id: string; name: string; allowed_packages: string }>()
	if (!row) return 'missing'
	const before = parseAllowedPackages(row.allowed_packages)
	if (before.length === 0 || before.includes(input.packageId)) {
		return 'already_allowed'
	}
	const after = parseAllowedPackages(
		stringifyAllowedPackages([...before, input.packageId]),
	)
	const now = new Date().toISOString()
	const update = input.db
		.prepare(
			`UPDATE secret_entries SET allowed_packages = ?, updated_at = ?
			 WHERE id = ? AND allowed_packages = ? AND deleted_at IS NULL`,
		)
		.bind(stringifyAllowedPackages(after), now, row.id, row.allowed_packages)
	if (!input.audit) {
		const result = await update.run()
		return result.meta?.changes ? 'granted' : 'conflict'
	}
	// The guarded UPDATE and its audit outbox row commit together, so a grant
	// is never left without its audit row.
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [update],
		onlyIfChanged: true,
		event: credentialAuditEvent({
			orgId: ownerIdFromStored(input.ownerId),
			credential: { id: row.id, kind: 'secret', name: row.name },
			action: credentialAuditActions.allowedPackagesUpdated,
			details: {
				packages: listDelta(before, after),
				fields: ['allowed_packages'],
				reason: allowedPackagesGrandfatherReason,
				source: input.source,
			},
		}),
	})
	if (!changed) return 'conflict'
	return 'granted'
}

/**
 * One page of the static join plus log cross-check, and (apply only) the
 * grants. dryRun (default) changes nothing.
 */
export async function runAllowedPackagesGrandfather(input: {
	env: Env
	audit: OrgAuditWriter | null
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	logSince: string
	logLastSeenAfter?: string | null
	includeLogOnly?: boolean
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
}): Promise<AllowedPackagesGrandfatherResult> {
	const dryRun = input.dryRun !== false
	const includeLogOnly = input.includeLogOnly !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ?? allowedPackagesGrandfatherScanLimitDefault,
			allowedPackagesGrandfatherScanLimitMax,
		),
	)
	const toSet = (values?: ReadonlyArray<string>) =>
		values?.length
			? new Set(values.map((value) => value.trim()).filter(Boolean))
			: undefined
	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds: toSet(input.packageIds),
		ownerUserIds: toSet(input.ownerUserIds),
	})
	const result: AllowedPackagesGrandfatherResult = {
		dryRun,
		scannedPackages: packages.length,
		staticScannedPackages: 0,
		skippedUnpublished: 0,
		skippedNoSnapshot: 0,
		skippedUnadoptedFork: 0,
		skippedEligibilityUnknown: 0,
		unparsedPackages: 0,
		unresolvedPackages: 0,
		pairs: 0,
		staticPairs: 0,
		logPairs: 0,
		bothPairs: 0,
		staticOnlyPairs: 0,
		logOnlyPairs: 0,
		logOnlyUnresolvedPairs: 0,
		logOnlyAdoptedPairs: 0,
		owners: 0,
		credentials: 0,
		packages: 0,
		wouldGrant: 0,
		granted: 0,
		alreadyAllowed: 0,
		missing: 0,
		conflicts: 0,
		nextCursor,
		details: [],
	}

	const excludingByOwner = new Map<
		string,
		Promise<Array<ExcludingCredential>>
	>()
	const excludingFor = (ownerId: string) => {
		let pending = excludingByOwner.get(ownerId)
		if (!pending) {
			pending = listExcludingUserCredentials(input.env.APP_DB, ownerId)
			excludingByOwner.set(ownerId, pending)
		}
		return pending
	}

	const byKey = new Map<string, AllowedPackagesGrandfatherPair>()
	const unresolvedPackages = new Set<string>()
	// Unpublished packages and unadopted forks cannot use the credential today,
	// so a log marker for one never earns a grant.
	const ineligiblePackages = new Set<string>()
	for (const savedPackage of packages) {
		let scan: StaticPackageScan
		try {
			scan = await scanPackageUserCredentialNames({
				env: input.env,
				savedPackage,
			})
		} catch {
			scan = { status: 'no_snapshot' }
		}
		if (scan.status !== 'scanned') {
			if (scan.status === 'unpublished') result.skippedUnpublished += 1
			if (scan.status === 'unadopted_fork') result.skippedUnadoptedFork += 1
			if (
				scan.status === 'unpublished' ||
				scan.status === 'unadopted_fork' ||
				scan.status === 'eligibility_unknown'
			) {
				ineligiblePackages.add(savedPackage.id)
			}
			if (scan.status === 'eligibility_unknown') {
				result.skippedEligibilityUnknown += 1
				unresolvedPackages.add(savedPackage.id)
			}
			if (scan.status === 'no_snapshot') {
				result.skippedNoSnapshot += 1
				unresolvedPackages.add(savedPackage.id)
			}
			continue
		}
		result.staticScannedPackages += 1
		if (scan.unparsed) result.unparsedPackages += 1
		if (scan.unresolved) unresolvedPackages.add(savedPackage.id)
		if (scan.names.length === 0) continue
		const names = new Set(scan.names)
		for (const credential of await excludingFor(savedPackage.userId)) {
			if (!names.has(credential.name)) continue
			if (credential.allowedPackages.includes(savedPackage.id)) continue
			byKey.set(`${credential.id}\0${savedPackage.id}`, {
				ownerId: savedPackage.userId,
				credentialId: credential.id,
				packageId: savedPackage.id,
				accessKind: scan.accessKind,
				source: 'static',
				packageUnresolved: scan.unresolved,
				logLastSeenAt: null,
				logObservations: 0,
				outcome: 'would_grant',
			})
		}
	}
	result.unresolvedPackages = unresolvedPackages.size

	const logRows = await listLogPairsForPackages({
		db: input.env.APP_DB,
		packageIds: packages.map((savedPackage) => savedPackage.id),
		since: input.logSince,
		lastSeenAfter: input.logLastSeenAfter ?? null,
	})
	for (const row of logRows) {
		if (ineligiblePackages.has(row.package_id)) continue
		const key = `${row.credential_id}\0${row.package_id}`
		const existing = byKey.get(key)
		if (existing) {
			existing.source = 'static+log'
			existing.logLastSeenAt = row.last_seen_at
			existing.logObservations = Number(row.observations)
			continue
		}
		if (!includeLogOnly) continue
		byKey.set(key, {
			ownerId: row.owner_id,
			credentialId: row.credential_id,
			packageId: row.package_id,
			accessKind: row.access_kind,
			source: 'log',
			packageUnresolved: unresolvedPackages.has(row.package_id),
			logLastSeenAt: row.last_seen_at,
			logObservations: Number(row.observations),
			outcome: 'would_grant',
		})
	}

	const owners = new Set<string>()
	const credentials = new Set<string>()
	const packageIds = new Set<string>()
	for (const pair of byKey.values()) {
		if (pair.source === 'log') {
			// The marker may predate an allow-list edit; only count live gaps.
			const excluding = await excludingFor(pair.ownerId)
			const credential = excluding.find((row) => row.id === pair.credentialId)
			if (!credential || credential.allowedPackages.includes(pair.packageId)) {
				pair.outcome = credential ? 'already_allowed' : 'missing'
			}
		}
		if (!dryRun && pair.outcome === 'would_grant') {
			pair.outcome = await grantGrandfatheredPackageAccess({
				db: input.env.APP_DB,
				audit: input.audit,
				ownerId: pair.ownerId,
				credentialId: pair.credentialId,
				packageId: pair.packageId,
				source: pair.source,
			})
		}
		switch (pair.outcome) {
			case 'would_grant':
				result.wouldGrant += 1
				break
			case 'granted':
				result.granted += 1
				break
			case 'already_allowed':
				result.alreadyAllowed += 1
				continue
			case 'missing':
				result.missing += 1
				continue
			case 'conflict':
				result.conflicts += 1
				break
		}
		result.pairs += 1
		owners.add(pair.ownerId)
		credentials.add(pair.credentialId)
		packageIds.add(pair.packageId)
		if (pair.source === 'static') result.staticOnlyPairs += 1
		if (pair.source === 'log') {
			result.logOnlyPairs += 1
			if (pair.packageUnresolved) result.logOnlyUnresolvedPairs += 1
			if (pair.accessKind === 'adopted') result.logOnlyAdoptedPairs += 1
		}
		if (pair.source === 'static+log') result.bothPairs += 1
		if (pair.source !== 'log') result.staticPairs += 1
		if (pair.source !== 'static') result.logPairs += 1
	}
	result.owners = owners.size
	result.credentials = credentials.size
	result.packages = packageIds.size
	result.details = [...byKey.values()]
	return result
}

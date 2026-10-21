/**
 * Read-only fleet impact of path-segment credential encoding (#3408 / #3425):
 * packages whose published source fills a Key into a URL path where the stored
 * value contains `/`, `?`, or `#`. Never returns secret values. Does not email
 * or notify owners.
 */
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { decryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { isDisconnectedSecretEncryptedValue } from '#mcp/secrets/disconnected.ts'
import { credentialValueHasPathRoutingCharacters } from '#mcp/secrets/path-segment-encoding-warning.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	getCredentialInventoryReport,
	type InventoryItemResult,
} from './credential-inventory.ts'

type ImpactCredentialRow = {
	id: string
	name: string
	encrypted_value: string
	/** Bucket owner — decrypt AAD and any other-org package Key. */
	ownerId: OwnerId
}

export type PathSegmentImpactPackage = {
	packageId: string
	ownerId: OwnerId
	ownerHandle: string | null
	packageName: string | null
	kodyId: string | null
	/** Credential display names (never values) that encode routing chars in a path fill. */
	credentialNames: Array<string>
}

export type PathSegmentImpactReport = {
	runId: string
	/** Path placement references in the inventory run (any secret value). */
	pathReferences: number
	/** Packages with at least one path placement. */
	packagesWithPathPlacement: number
	/**
	 * Packages that fill a path with a Key whose stored value contains `/`,
	 * `?`, or `#`.
	 */
	packagesWithRoutingChars: number
	/** Distinct credentials (by id) in those packages. */
	credentialsWithRoutingChars: number
	/** Path credentials that could not be decrypted (excluded from routing counts). */
	undecryptableCredentials: number
	/**
	 * Affected packages for private outreach decisions. Admin-only; do not
	 * paste into public PR/issue/commit text.
	 */
	packages: Array<PathSegmentImpactPackage>
}

type InventoryItemRow = {
	packageId: string
	ownerId: OwnerId
	result: InventoryItemResult | null
}

async function loadScannedItemsWithOwners(db: D1Database, runId: string) {
	const rows = await db
		.prepare(
			`SELECT package_id, user_id, status, result_json FROM credential_inventory_items
			WHERE run_id = ? AND status = 'scanned' ORDER BY package_id`,
		)
		.bind(runId)
		.all<{
			package_id: string
			user_id: string
			status: string
			result_json: string
		}>()
	return (rows.results ?? []).map((row): InventoryItemRow => ({
		packageId: row.package_id,
		ownerId: row.user_id as OwnerId,
		result: JSON.parse(row.result_json) as InventoryItemResult,
	}))
}

async function loadPackageIdentity(
	db: D1Database,
	packageIds: ReadonlyArray<string>,
) {
	const byId = new Map<
		string,
		{ name: string | null; kodyId: string | null; ownerId: OwnerId }
	>()
	if (packageIds.length === 0) return byId
	const chunkSize = 50
	for (let offset = 0; offset < packageIds.length; offset += chunkSize) {
		const chunk = packageIds.slice(offset, offset + chunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT id, user_id, name, kody_id FROM saved_packages
				WHERE id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{
				id: string
				user_id: string
				name: string | null
				kody_id: string | null
			}>()
		for (const row of rows.results ?? []) {
			byId.set(row.id, {
				name: row.name,
				kodyId: row.kody_id,
				ownerId: row.user_id as OwnerId,
			})
		}
	}
	return byId
}

async function loadOwnerHandles(
	db: D1Database,
	ownerIds: ReadonlyArray<OwnerId>,
) {
	const byId = new Map<OwnerId, string | null>()
	if (ownerIds.length === 0) return byId
	const chunkSize = 50
	for (let offset = 0; offset < ownerIds.length; offset += chunkSize) {
		const chunk = ownerIds.slice(offset, offset + chunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const rows = await db
			.prepare(
				`SELECT u.stable_user_id AS stable_user_id, u.username AS username
				FROM users u
				WHERE u.stable_user_id IN (${placeholders})${andLiveDeletedAtSql('u')}`,
			)
			.bind(...chunk)
			.all<{ stable_user_id: string; username: string | null }>()
		for (const row of rows.results ?? []) {
			byId.set(row.stable_user_id as OwnerId, row.username)
		}
	}
	return byId
}

/**
 * Resolve a Key by id from any live bucket (publisher user-scope or any org's
 * package-scope binding). Inventory path refs can name non-publisher Keys.
 */
async function loadCredentialByIdForImpact(
	db: D1Database,
	credentialId: string,
	now = new Date().toISOString(),
): Promise<ImpactCredentialRow | null> {
	const row = await db
		.prepare(
			`SELECT e.id AS id, e.name AS name, e.encrypted_value AS encrypted_value,
				b.user_id AS user_id
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE e.id = ?
				AND (
					(b.scope = 'user' AND b.binding_key = '')
					OR b.scope = 'package'
				)
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			LIMIT 1`,
		)
		.bind(credentialId, now, now)
		.first<{
			id: string
			name: string
			encrypted_value: string
			user_id: string
		}>()
	if (!row) return null
	return {
		id: row.id,
		name: row.name,
		encrypted_value: row.encrypted_value,
		ownerId: ownerIdFromStored(row.user_id),
	}
}

/**
 * From a complete credential inventory run, count packages whose path fill
 * would encode `/`, `?`, or `#` from a stored Key value.
 */
export async function analyzeCredentialPathSegmentImpact(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	runId: string
}): Promise<PathSegmentImpactReport> {
	const { report, complete } = await getCredentialInventoryReport(
		input.env.APP_DB,
		input.runId,
	)
	if (!complete) {
		throw new Error(
			'Credential inventory run is not complete. Finish adminCredentialInventoryScan first.',
		)
	}
	const items = await loadScannedItemsWithOwners(input.env.APP_DB, input.runId)
	const pathReferences = report.references.byPlacement.path
	const packagesWithPath = new Set<string>()
	/** packageId → Map<credentialId, name> for secrets that encode routing chars. */
	const affectedByPackage = new Map<string, Map<string, string>>()
	/** credentialId → credential name when routing chars encode, else null. */
	const routingNameByCredential = new Map<string, string | null>()
	const undecryptableCredentialIds = new Set<string>()

	for (const item of items) {
		if (!item.result) continue
		for (const reference of item.result.references) {
			if (reference.placement.type !== 'path') continue
			if (reference.table !== 'secret') continue
			packagesWithPath.add(item.packageId)
			for (const credentialId of reference.credentialIds) {
				let credentialName = routingNameByCredential.get(credentialId)
				if (credentialName === undefined) {
					const entry = await loadCredentialByIdForImpact(
						input.env.APP_DB,
						credentialId,
					)
					if (
						!entry ||
						isDisconnectedSecretEncryptedValue(entry.encrypted_value)
					) {
						credentialName = null
					} else {
						try {
							const value = await decryptSecretValue(
								input.env,
								entry.encrypted_value,
								userSecretContext(entry.ownerId),
							)
							credentialName = credentialValueHasPathRoutingCharacters(value)
								? entry.name
								: null
						} catch {
							undecryptableCredentialIds.add(credentialId)
							credentialName = null
						}
					}
					routingNameByCredential.set(credentialId, credentialName)
				}
				if (credentialName) {
					const names =
						affectedByPackage.get(item.packageId) ?? new Map<string, string>()
					names.set(credentialId, credentialName)
					affectedByPackage.set(item.packageId, names)
				}
			}
		}
	}

	const packageIds = [...affectedByPackage.keys()]
	const identity = await loadPackageIdentity(input.env.APP_DB, packageIds)
	const ownerIds = [
		...new Set(
			packageIds.map(
				(id) =>
					identity.get(id)?.ownerId ??
					(items.find((i) => i.packageId === id)?.ownerId as OwnerId),
			),
		),
	].filter(Boolean) as Array<OwnerId>
	const handles = await loadOwnerHandles(input.env.APP_DB, ownerIds)

	const packages: Array<PathSegmentImpactPackage> = packageIds
		.map((packageId) => {
			const meta = identity.get(packageId)
			const ownerId =
				meta?.ownerId ??
				(items.find((item) => item.packageId === packageId)?.ownerId as OwnerId)
			const names = affectedByPackage.get(packageId)!
			return {
				packageId,
				ownerId,
				ownerHandle: handles.get(ownerId) ?? null,
				packageName: meta?.name ?? null,
				kodyId: meta?.kodyId ?? null,
				credentialNames: [...names.values()].sort((a, b) => a.localeCompare(b)),
			}
		})
		.sort(
			(left, right) =>
				(left.ownerHandle ?? '').localeCompare(right.ownerHandle ?? '') ||
				(left.packageName ?? left.packageId).localeCompare(
					right.packageName ?? right.packageId,
				),
		)

	const credentialIds = new Set<string>()
	for (const names of affectedByPackage.values()) {
		for (const id of names.keys()) credentialIds.add(id)
	}

	return {
		runId: input.runId,
		pathReferences,
		packagesWithPathPlacement: packagesWithPath.size,
		packagesWithRoutingChars: packages.length,
		credentialsWithRoutingChars: credentialIds.size,
		undecryptableCredentials: undecryptableCredentialIds.size,
		packages,
	}
}

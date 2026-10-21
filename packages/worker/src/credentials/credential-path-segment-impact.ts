/**
 * Read-only fleet impact of path-segment credential encoding (#3408 / #3425):
 * packages whose published source fills a Key into a URL path where the stored
 * value contains `/`, `?`, or `#`. Never returns secret values. Does not email
 * or notify owners.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { decryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { isDisconnectedSecretEncryptedValue } from '#mcp/secrets/disconnected.ts'
import { getStoredCredentialEntry } from '#mcp/secrets/repo.ts'
import { credentialValueHasPathRoutingCharacters } from '#mcp/secrets/path-segment-encoding-warning.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	getCredentialInventoryReport,
	type InventoryItemResult,
} from './credential-inventory.ts'

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
				`SELECT stable_user_id, username FROM users
				WHERE stable_user_id IN (${placeholders})`,
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
	/** ownerId\0credentialId → credential name when routing chars encode, else null. */
	const routingNameByCredential = new Map<string, string | null>()

	for (const item of items) {
		if (!item.result) continue
		for (const reference of item.result.references) {
			if (reference.placement.type !== 'path') continue
			if (reference.table !== 'secret') continue
			packagesWithPath.add(item.packageId)
			for (const credentialId of reference.credentialIds) {
				const cacheKey = `${item.ownerId}\0${credentialId}`
				let credentialName = routingNameByCredential.get(cacheKey)
				if (credentialName === undefined) {
					const entry = await getStoredCredentialEntry({
						db: input.env.APP_DB,
						ownerId: item.ownerId,
						credentialId,
					})
					if (
						!entry ||
						isDisconnectedSecretEncryptedValue(entry.encrypted_value)
					) {
						credentialName = null
					} else {
						const value = await decryptSecretValue(
							input.env,
							entry.encrypted_value,
							userSecretContext(item.ownerId),
						)
						credentialName = credentialValueHasPathRoutingCharacters(value)
							? entry.name
							: null
					}
					routingNameByCredential.set(cacheKey, credentialName)
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
		packages,
	}
}

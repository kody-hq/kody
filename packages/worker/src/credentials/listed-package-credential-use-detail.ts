/**
 * Read-only detail for one package on a credential's allowed-packages list:
 * whether the stored bundles that read `fetch` through the global object
 * also refer to a credential that is locked to the package. Counts and
 * booleans only. Writes nothing.
 */
import { parseAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import {
	isPlatformRuntimeModulePath,
	moduleSource,
} from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	listedPackageFetchBindingScanBundlesPerCall,
	readStoredBundles,
	scanModulesForGlobalObjectFetch,
} from './listed-package-fetch-binding-scan.ts'
import { findPlaceholderMatches } from './module-placeholder-scan.ts'

export type ListedPackageCredentialUseDetail = {
	packageId: string
	found: boolean
	/** Credentials whose allowed-packages list names this package. */
	credentials: Array<{
		credentialId: string
		ownerIsPackageOwner: boolean
		/** Saved credential mappings of this package that point at it. */
		mappedNeeds: number
	}>
	bundles: number
	/** Bundles with a `globalThis.fetch` / `self.fetch` read. */
	bundlesWithDirectRead: number
	/** Counted in the bundles with such a read only. */
	directReadBundles: {
		/** Bundles with a secret placeholder that names a listed credential. */
		withLockedCredentialPlaceholder: number
		lockedCredentialPlaceholders: number
		/** Bundles with a secret or integration placeholder of any name. */
		withAnyPlaceholder: number
		anyPlaceholders: number
		/** Bundles that call `credential(...)` or `credentials(...)`. */
		withCredentialClientCall: number
		credentialClientCalls: number
	}
	/** Pass back as `offset` to read the rest of the bundles; null when done. */
	nextOffset: number | null
}

const secretRefCallPattern = /__kodySecretRef\(\s*"([^"\\]+)"/g
const credentialClientCallPattern = /(?<![\w$.])credentials?\d*\s*\(/g

export function countCredentialReferences(
	modules: Record<string, unknown>,
	lockedNames: ReadonlySet<string>,
) {
	const counts = { locked: 0, any: 0, clientCalls: 0 }
	for (const [modulePath, module] of Object.entries(modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module as never)
		if (source == null) continue
		const names = [
			...findPlaceholderMatches(source).map((match) => match.names),
			...[...source.matchAll(secretRefCallPattern)].map((match) => [match[1]!]),
		]
		for (const placeholderNames of names) {
			counts.any += 1
			if (placeholderNames.some((name) => lockedNames.has(name))) {
				counts.locked += 1
			}
		}
		counts.clientCalls += [
			...source.matchAll(credentialClientCallPattern),
		].length
	}
	return counts
}

export async function runListedPackageCredentialUseDetail(input: {
	env: Env
	packageId: string
	offset?: number
	bundlesPerCall?: number
}): Promise<ListedPackageCredentialUseDetail> {
	const detail: ListedPackageCredentialUseDetail = {
		packageId: input.packageId,
		found: false,
		credentials: [],
		bundles: 0,
		bundlesWithDirectRead: 0,
		directReadBundles: {
			withLockedCredentialPlaceholder: 0,
			lockedCredentialPlaceholders: 0,
			withAnyPlaceholder: 0,
			anyPlaceholders: 0,
			withCredentialClientCall: 0,
			credentialClientCalls: 0,
		},
		nextOffset: null,
	}
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	if (!savedPackage) return detail
	detail.found = true
	const listed = await input.env.APP_DB.prepare(
		`SELECT e.id AS id, e.name AS name, b.user_id AS owner_id, e.allowed_packages AS allowed_packages
		 FROM secret_entries e
		 JOIN secret_buckets b ON b.id = e.bucket_id
		 WHERE e.id IS NOT NULL
		   AND e.allowed_packages LIKE ?${andLiveDeletedAtSql('e')}${andLiveDeletedAtSql('b')}`,
	)
		.bind(`%${input.packageId}%`)
		.all<{
			id: string
			name: string
			owner_id: string
			allowed_packages: string
		}>()
	const credentials = (listed.results ?? []).filter((row) =>
		parseAllowedPackages(row.allowed_packages).includes(input.packageId),
	)
	const mappings = await input.env.APP_DB.prepare(
		`SELECT credential_ids_json FROM credential_mappings WHERE package_id = ?`,
	)
		.bind(input.packageId)
		.all<{ credential_ids_json: string }>()
	detail.credentials = credentials.map((row) => ({
		credentialId: row.id,
		ownerIsPackageOwner: row.owner_id === savedPackage.userId,
		mappedNeeds: (mappings.results ?? []).filter((mapping) =>
			mapping.credential_ids_json.includes(`"${row.id}"`),
		).length,
	}))
	const lockedNames = new Set(credentials.map((row) => row.name))
	const offset = Math.max(0, input.offset ?? 0)
	const { bundles, rows, more } = await readStoredBundles({
		env: input.env,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
		offset,
		maxRows: Math.max(
			1,
			input.bundlesPerCall ?? listedPackageFetchBindingScanBundlesPerCall,
		),
	})
	detail.nextOffset = more ? offset + rows : null
	const totals = detail.directReadBundles
	for (const bundle of bundles) {
		detail.bundles += 1
		const modules = bundle.modules ?? {}
		if (!(await scanModulesForGlobalObjectFetch(modules)).globalReads) continue
		detail.bundlesWithDirectRead += 1
		const counts = countCredentialReferences(modules, lockedNames)
		totals.lockedCredentialPlaceholders += counts.locked
		totals.anyPlaceholders += counts.any
		totals.credentialClientCalls += counts.clientCalls
		if (counts.locked > 0) totals.withLockedCredentialPlaceholder += 1
		if (counts.any > 0) totals.withAnyPlaceholder += 1
		if (counts.clientCalls > 0) totals.withCredentialClientCall += 1
	}
	return detail
}

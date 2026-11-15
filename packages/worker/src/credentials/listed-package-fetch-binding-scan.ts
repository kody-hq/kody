/**
 * Read-only scan of the stored bundles of packages that appear on a
 * credential's allowed-packages list, for reads of `fetch` through the global
 * object (`globalThis.fetch`, `self.fetch`). Reports where each bundle would
 * land if those reads had to carry the package's own identity. Writes nothing.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { parseAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceRowForUser,
	loadServingPackageSourceBySourceId,
} from '#worker/package-registry/source.ts'
import { collectPublishedPackageArtifactTargets } from '#worker/package-runtime/package-artifact-targets.ts'
import {
	isPlatformRuntimeModulePath,
	isRepairableArtifactKind,
	moduleSource,
	publishedArtifactInlinesOtherPackages,
} from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import {
	loadPublishedBundleArtifactsForPackageTargets,
	publishedBundleArtifactForPackageTarget,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { listCandidatePackages } from '#worker/package-runtime/published-importable-artifact-backfill.ts'
import { listMissingPublishedSourceInstalledDependencies } from '#worker/package-runtime/published-source-dependencies.ts'
import {
	collectTopLevelFetchCollisionNames,
	rewriteGlobalObjectFetchReads,
} from '#worker/package-runtime/rewrite-local-execute-secret-fetch.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const listedPackageFetchBindingScanLimitDefault = 20
export const listedPackageFetchBindingScanLimitMax = 50
const shapeLengthMax = 60
const shapesPerPackageMax = 6

/**
 * Where a package's stored bundles land, worst bundle first:
 * - `needs_install_to_rebuild`: a bundle inlines other packages, has such a
 *   read, and its source needs an npm install to build again.
 * - `not_parsed`: a bundle has such a read but its module could not be parsed.
 * - `rebuild_from_source`: a bundle inlines other packages and has such a
 *   read; its source builds again without an install.
 * - `bound_in_place`: only single-package bundles have such reads.
 * - `no_global_reads`: no bundle has such a read.
 */
export type ListedPackageFetchBindingOutcome =
	| 'needs_install_to_rebuild'
	| 'not_parsed'
	| 'rebuild_from_source'
	| 'bound_in_place'
	| 'no_global_reads'
	| 'unpublished'
	| 'no_stored_bundles'
	| 'failed'

export type ListedPackageFetchBindingPackage = {
	packageId: string
	outcome: ListedPackageFetchBindingOutcome
	bundles: number
	bundlesWithGlobalReads: number
	/**
	 * Upper bound, not a finding: a module both uses the global object as a
	 * value and reads `.fetch` from some other name, so it may reach fetch
	 * through an alias. Most matches are ordinary option objects.
	 */
	possibleAlias: boolean
	/** Matched text only (names and punctuation), for a possible alias. */
	possibleAliasShapes: Array<string>
	error?: string
}

export type ListedPackageFetchBindingScanResult = {
	/** Present on the first page only. Ids only, no names or values. */
	lists: Array<{
		credentialId: string
		ownerId: string
		packageIds: Array<string>
	}> | null
	packages: Array<ListedPackageFetchBindingPackage>
	nextCursor: string | null
}

const scanProbeName = '__kodyListedPackageScanFetch'
const globalObjectAsValuePattern =
	/(?:[=(,?:]|\breturn)\s*(?:globalThis|self)\s*(?=[;,)\n}]|\|\||\?\?|$)/g
const otherFetchReadPattern =
	/(?<![\w$.])(?!globalThis\b|self\b|this\b)[A-Za-z_$][\w$]*\s*\??\.\s*fetch\b/g

function shapesOf(source: string, pattern: RegExp) {
	const shapes = new Set<string>()
	for (const match of source.matchAll(pattern)) {
		shapes.add(match[0].replace(/\s+/g, ' ').trim().slice(0, shapeLengthMax))
		if (shapes.size >= shapesPerPackageMax) break
	}
	return [...shapes]
}

type ScannedModules = {
	globalReads: boolean
	notParsed: boolean
	aliasShapes: Array<string>
}

export function scanModulesForGlobalObjectFetch(
	modules: Record<string, unknown>,
): ScannedModules {
	const scanned: ScannedModules = {
		globalReads: false,
		notParsed: false,
		aliasShapes: [],
	}
	for (const [modulePath, module] of Object.entries(modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module as never)
		if (source == null || !source.includes('fetch')) continue
		if (rewriteGlobalObjectFetchReads(source, scanProbeName) !== source) {
			scanned.globalReads = true
			if (!collectTopLevelFetchCollisionNames(source)) scanned.notParsed = true
		}
		const asValue = shapesOf(source, globalObjectAsValuePattern)
		if (asValue.length === 0) continue
		const otherReads = shapesOf(source, otherFetchReadPattern)
		if (otherReads.length === 0) continue
		scanned.aliasShapes.push(...asValue, ...otherReads)
	}
	scanned.aliasShapes = [...new Set(scanned.aliasShapes)].slice(
		0,
		shapesPerPackageMax,
	)
	return scanned
}

async function listLists(db: D1Database) {
	const result = await db
		.prepare(
			`SELECT e.id AS id, b.user_id AS owner_id, e.allowed_packages AS allowed_packages
			 FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id IS NOT NULL
			   AND e.allowed_packages != '[]'${andLiveDeletedAtSql('e')}${andLiveDeletedAtSql('b')}`,
		)
		.all<{ id: string; owner_id: string; allowed_packages: string }>()
	return (result.results ?? [])
		.map((row) => ({
			credentialId: row.id,
			ownerId: row.owner_id,
			packageIds: parseAllowedPackages(row.allowed_packages),
		}))
		.filter((row) => row.packageIds.length > 0)
}

const outcomeRank: Array<ListedPackageFetchBindingOutcome> = [
	'no_global_reads',
	'bound_in_place',
	'rebuild_from_source',
	'not_parsed',
	'needs_install_to_rebuild',
]

async function scanPackage(input: {
	env: Env
	baseUrl: string
	packageId: string
	userId: OwnerId
	sourceId: string
}): Promise<ListedPackageFetchBindingPackage> {
	const base = {
		packageId: input.packageId,
		bundles: 0,
		bundlesWithGlobalReads: 0,
		possibleAlias: false,
		possibleAliasShapes: [] as Array<string>,
	}
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const publishedCommit = source.published_commit?.trim() || null
	if (!publishedCommit) return { ...base, outcome: 'unpublished' }
	const { manifest } = await loadPackageManifestForSource({
		env: input.env,
		userId: input.userId,
		source,
	})
	const targets = collectPublishedPackageArtifactTargets(manifest).filter(
		(target) => isRepairableArtifactKind(target.kind),
	)
	const loadedByIdentity = targets.length
		? await loadPublishedBundleArtifactsForPackageTargets({
				env: input.env,
				userId: input.userId,
				sourceId: input.sourceId,
				targets,
			})
		: new Map()
	let outcome: ListedPackageFetchBindingOutcome = 'no_global_reads'
	let needsInstall: boolean | null = null
	const shapes = new Set<string>()
	for (const target of targets) {
		const artifact = publishedBundleArtifactForPackageTarget({
			sourceId: input.sourceId,
			target,
			loadedByIdentity,
		})?.artifact
		if (!artifact) continue
		base.bundles += 1
		const scanned = scanModulesForGlobalObjectFetch(artifact.modules)
		for (const shape of scanned.aliasShapes) shapes.add(shape)
		if (!scanned.globalReads) continue
		base.bundlesWithGlobalReads += 1
		let bundleOutcome: ListedPackageFetchBindingOutcome = 'bound_in_place'
		if (scanned.notParsed) {
			bundleOutcome = 'not_parsed'
		} else if (publishedArtifactInlinesOtherPackages(artifact)) {
			if (needsInstall == null) {
				const packageSource = await loadServingPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: input.sourceId,
				})
				needsInstall =
					listMissingPublishedSourceInstalledDependencies(packageSource.files)
						.length > 0
			}
			bundleOutcome = needsInstall
				? 'needs_install_to_rebuild'
				: 'rebuild_from_source'
		}
		if (outcomeRank.indexOf(bundleOutcome) > outcomeRank.indexOf(outcome)) {
			outcome = bundleOutcome
		}
	}
	if (base.bundles === 0) return { ...base, outcome: 'no_stored_bundles' }
	return {
		...base,
		outcome,
		possibleAlias: shapes.size > 0,
		possibleAliasShapes: [...shapes].slice(0, shapesPerPackageMax),
	}
}

export async function runListedPackageFetchBindingScan(input: {
	env: Env
	baseUrl: string
	afterId?: string | null
	limit?: number
}): Promise<ListedPackageFetchBindingScanResult> {
	const limit = Math.max(
		1,
		Math.min(
			input.limit ?? listedPackageFetchBindingScanLimitDefault,
			listedPackageFetchBindingScanLimitMax,
		),
	)
	const lists = await listLists(input.env.APP_DB)
	const listedPackageIds = new Set(lists.flatMap((list) => list.packageIds))
	const result: ListedPackageFetchBindingScanResult = {
		lists: input.afterId ? null : lists,
		packages: [],
		nextCursor: null,
	}
	if (listedPackageIds.size === 0) return result
	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds: listedPackageIds,
	})
	result.nextCursor = nextCursor
	for (const savedPackage of packages) {
		try {
			result.packages.push(
				await scanPackage({
					env: input.env,
					baseUrl: input.baseUrl,
					packageId: savedPackage.id,
					userId: savedPackage.userId,
					sourceId: savedPackage.sourceId,
				}),
			)
		} catch (error) {
			result.packages.push({
				packageId: savedPackage.id,
				outcome: 'failed',
				bundles: 0,
				bundlesWithGlobalReads: 0,
				possibleAlias: false,
				possibleAliasShapes: [],
				error: getErrorMessage(error).slice(0, 200),
			})
		}
	}
	return result
}

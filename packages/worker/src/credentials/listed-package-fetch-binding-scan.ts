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
	isPlatformRuntimeModulePath,
	isRepairableArtifactKind,
	moduleSource,
} from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import {
	hasPublishedRuntimeArtifacts,
	loadPublishedSourceSnapshot,
	readPublishedBundleArtifact,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { listCandidatePackages } from '#worker/package-runtime/published-importable-artifact-backfill.ts'
import { listMissingPublishedSourceInstalledDependencies } from '#worker/package-runtime/published-source-dependencies.ts'
import { rewriteGlobalObjectFetchReads } from '#worker/package-runtime/rewrite-local-execute-secret-fetch.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	analyzeGlobalObjectFetchReads,
	type GlobalObjectFetchReadAnalysis,
} from './global-object-fetch-read-analysis.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const listedPackageFetchBindingScanLimitDefault = 20
export const listedPackageFetchBindingScanLimitMax = 50
/**
 * Stored bundles read in one call. A package keeps a bundle for every
 * publish, so one package alone can hold more than a request can parse.
 */
export const listedPackageFetchBindingScanBundlesPerCall = 25
const shapesPerPackageMax = 8

/**
 * Where a package's stored bundles land, worst bundle first:
 * - `unbound_reads`: a bundle reads fetch from the global object in a way
 *   the on-load bind does not cover (another name for the global object).
 * - `needs_install_to_rebuild`: a bundle inlines other packages, has such a
 *   read, and its source needs an npm install to build again.
 * - `not_parsed`: a bundle has such a read but its module could not be parsed.
 * - `rebuild_from_source`: a bundle inlines other packages and has such a
 *   read; its source builds again without an install.
 * - `bound_in_place`: only single-package bundles have such reads.
 * - `no_global_reads`: no bundle has such a read.
 */
export type ListedPackageFetchBindingOutcome =
	| 'unbound_reads'
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
	/** Short code shapes of the reads behind `unbound_reads`. */
	unboundReadShapes: Array<string>
	/**
	 * Upper bound, not a finding: a module has a read of `.fetch`, or a
	 * computed read from the global object, that could not be shown to come
	 * from somewhere other than the global object.
	 */
	unresolved: boolean
	/** Short code shapes (names and punctuation) of the unresolved reads. */
	unresolvedShapes: Array<string>
	/**
	 * Bundles reading `window.fetch` or `global.fetch`. Neither name is
	 * defined in the package runtime, so these are reported and not counted.
	 */
	bundlesWithUndefinedGlobalReads: number
	/**
	 * True when this call stopped part way through the package's bundles. The
	 * next page reports the same package again for the rest: add the counts
	 * and keep the worst outcome.
	 */
	partial?: boolean
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
const analysisPrecheckPattern =
	/\b(?:globalThis|self|window|global)\b|return this|\beval\b/

type ScannedModules = {
	globalReads: boolean
	notParsed: boolean
	unboundShapes: Array<string>
	unresolvedShapes: Array<string>
	undefinedGlobalReads: number
}

export async function scanModulesForGlobalObjectFetch(
	modules: Record<string, unknown>,
): Promise<ScannedModules> {
	const scanned: ScannedModules = {
		globalReads: false,
		notParsed: false,
		unboundShapes: [],
		unresolvedShapes: [],
		undefinedGlobalReads: 0,
	}
	const unbound = new Set<string>()
	const unresolved = new Set<string>()
	for (const [modulePath, module] of Object.entries(modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module as never)
		if (source == null || !source.includes('fetch')) continue
		if (!analysisPrecheckPattern.test(source)) continue
		let analysis: GlobalObjectFetchReadAnalysis
		try {
			analysis = analyzeGlobalObjectFetchReads(
				(await parseModuleSource(source)) as unknown as ModuleAstNode,
				source,
			)
		} catch {
			// Unreadable, so it cannot be shown to have no such read.
			scanned.globalReads = true
			scanned.notParsed = true
			continue
		}
		scanned.undefinedGlobalReads += analysis.undefinedGlobalReads
		for (const shape of analysis.aliasReadShapes) unbound.add(shape)
		for (const shape of analysis.unresolvedReadShapes) unresolved.add(shape)
		if (analysis.directReads === 0) continue
		scanned.globalReads = true
		const bound =
			(await rewriteGlobalObjectFetchReads(source, scanProbeName)).split(
				scanProbeName,
			).length - 1
		if (bound < analysis.directReads) {
			unbound.add('globalThis.fetch or self.fetch that the bind leaves alone')
		}
	}
	scanned.unboundShapes = [...unbound].slice(0, shapesPerPackageMax)
	scanned.unresolvedShapes = [...unresolved].slice(0, shapesPerPackageMax)
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
	'unbound_reads',
]

export type StoredBundle = {
	kind?: string | null
	modules?: Record<string, unknown>
	dependencies?: Array<{ packageId?: string | null }>
	packageContext?: { packageId?: string | null } | null
}

/**
 * Reads the stored rows and payloads directly. The runtime loaders recover
 * and save a missing snapshot as they go, and this scan must not write.
 */
export async function readStoredBundles(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	offset: number
	maxRows: number
}): Promise<{ bundles: Array<StoredBundle>; rows: number; more: boolean }> {
	if (!hasPublishedRuntimeArtifacts(input.env)) {
		return { bundles: [], rows: 0, more: false }
	}
	const result = await input.env.APP_DB.prepare(
		`SELECT kv_key, artifact_kind FROM published_bundle_artifacts
		 WHERE user_id = ? AND source_id = ?
		 ORDER BY kv_key
		 LIMIT ? OFFSET ?`,
	)
		.bind(input.userId, input.sourceId, input.maxRows + 1, input.offset)
		.all<{ kv_key: string; artifact_kind: string }>()
	const rows = (result.results ?? []).slice(0, input.maxRows)
	const more = (result.results ?? []).length > input.maxRows
	const bundles: Array<StoredBundle> = []
	for (const row of rows) {
		if (!isRepairableArtifactKind(row.artifact_kind)) continue
		const stored = await readPublishedBundleArtifact({
			env: input.env,
			kvKey: row.kv_key,
		})
		if (!stored?.modules) continue
		bundles.push({ ...stored, kind: stored.kind ?? row.artifact_kind })
	}
	return { bundles, rows: rows.length, more }
}

function inlinesOtherPackages(bundle: StoredBundle) {
	const ownPackageId = bundle.packageContext?.packageId ?? null
	return (bundle.dependencies ?? []).some(
		(dependency) =>
			!dependency.packageId || dependency.packageId !== ownPackageId,
	)
}

async function scanPackage(input: {
	env: Env
	packageId: string
	userId: OwnerId
	sourceId: string
	offset: number
	maxRows: number
}): Promise<{
	scanned: ListedPackageFetchBindingPackage
	rows: number
	more: boolean
}> {
	const base = {
		packageId: input.packageId,
		bundles: 0,
		bundlesWithGlobalReads: 0,
		unboundReadShapes: [] as Array<string>,
		unresolved: false,
		unresolvedShapes: [] as Array<string>,
		bundlesWithUndefinedGlobalReads: 0,
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		return {
			scanned: { ...base, outcome: 'unpublished' },
			rows: 0,
			more: false,
		}
	}
	if (!source.published_commit?.trim()) {
		return {
			scanned: { ...base, outcome: 'unpublished' },
			rows: 0,
			more: false,
		}
	}
	const { bundles, rows, more } = await readStoredBundles(input)
	const partial = more || input.offset > 0 ? { partial: true } : {}
	let outcome: ListedPackageFetchBindingOutcome = 'no_global_reads'
	let needsInstall: boolean | null = null
	const unbound = new Set<string>()
	const unresolved = new Set<string>()
	for (const bundle of bundles) {
		base.bundles += 1
		const scanned = await scanModulesForGlobalObjectFetch(bundle.modules ?? {})
		for (const shape of scanned.unboundShapes) unbound.add(shape)
		for (const shape of scanned.unresolvedShapes) unresolved.add(shape)
		if (scanned.undefinedGlobalReads > 0) {
			base.bundlesWithUndefinedGlobalReads += 1
		}
		if (!scanned.globalReads && scanned.unboundShapes.length === 0) continue
		base.bundlesWithGlobalReads += 1
		let bundleOutcome: ListedPackageFetchBindingOutcome = 'bound_in_place'
		if (scanned.unboundShapes.length > 0) {
			bundleOutcome = 'unbound_reads'
		} else if (scanned.notParsed) {
			bundleOutcome = 'not_parsed'
		} else if (inlinesOtherPackages(bundle)) {
			if (needsInstall == null) {
				// No saved source snapshot counts as needing an install: the
				// scan cannot show that the source builds again on its own.
				const snapshot = await loadPublishedSourceSnapshot({
					env: input.env,
					userId: input.userId,
					source,
				})
				needsInstall =
					!snapshot ||
					listMissingPublishedSourceInstalledDependencies(snapshot.files)
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
	if (base.bundles === 0 && !more && input.offset === 0) {
		return {
			scanned: { ...base, outcome: 'no_stored_bundles' },
			rows,
			more,
		}
	}
	return {
		scanned: {
			...base,
			...partial,
			outcome,
			unboundReadShapes: [...unbound].slice(0, shapesPerPackageMax),
			unresolved: unresolved.size > 0,
			unresolvedShapes: [...unresolved].slice(0, shapesPerPackageMax),
		},
		rows,
		more,
	}
}

const cursorOffsetSeparator = '~'

/** `<package id>` or `<package id>~<bundle offset in the next package>`. */
function parseScanCursor(cursor: string | null | undefined) {
	if (!cursor) return { afterId: null, offset: 0 }
	const at = cursor.lastIndexOf(cursorOffsetSeparator)
	if (at < 0) return { afterId: cursor, offset: 0 }
	const offset = Number(cursor.slice(at + 1))
	return {
		afterId: cursor.slice(0, at) || null,
		offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
	}
}

export async function runListedPackageFetchBindingScan(input: {
	env: Env
	cursor?: string | null
	limit?: number
	bundlesPerCall?: number
}): Promise<ListedPackageFetchBindingScanResult> {
	const start = parseScanCursor(input.cursor)
	let budget = Math.max(
		1,
		input.bundlesPerCall ?? listedPackageFetchBindingScanBundlesPerCall,
	)
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
		lists: input.cursor ? null : lists,
		packages: [],
		nextCursor: null,
	}
	if (listedPackageIds.size === 0) return result
	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: start.afterId,
		limit,
		packageIds: listedPackageIds,
	})
	result.nextCursor = nextCursor
	let previousId = start.afterId
	for (const [index, savedPackage] of packages.entries()) {
		if (budget <= 0) {
			result.nextCursor = previousId
			break
		}
		const offset = index === 0 ? start.offset : 0
		try {
			const { scanned, rows, more } = await scanPackage({
				env: input.env,
				packageId: savedPackage.id,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
				offset,
				maxRows: budget,
			})
			result.packages.push(scanned)
			budget -= rows
			if (more) {
				result.nextCursor = `${previousId ?? ''}${cursorOffsetSeparator}${offset + rows}`
				break
			}
		} catch (error) {
			result.packages.push({
				packageId: savedPackage.id,
				outcome: 'failed',
				bundles: 0,
				bundlesWithGlobalReads: 0,
				unboundReadShapes: [],
				unresolved: false,
				unresolvedShapes: [],
				bundlesWithUndefinedGlobalReads: 0,
				error: getErrorMessage(error).slice(0, 200),
			})
			// How many bundles were read before the failure is unknown, so the
			// page ends here instead of reading more than its share.
			budget = 0
		}
		previousId = savedPackage.id
	}
	return result
}

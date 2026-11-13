/**
 * `POST /v1/local-execute/package-graph` without risking the API isolate.
 *
 * A graph build loads every imported package's published artifacts (or its
 * source) and rewrites them, which takes hundreds of MB for a large private
 * package. Built inside `KodyApi`, one such build reset the shared isolate and
 * every other in-flight request with it (execution-context `execute` 503s,
 * 2026-11-13). Now:
 *
 * 1. The API isolate resolves each direct import to its package id and
 *    serving commit (D1 reads, permission-checked) and hashes them with the
 *    org, base URL, and worker version into a content-addressed cache key.
 * 2. A cached unsigned graph is signed for the caller and returned. A new
 *    commit on any imported package changes the key, so it misses.
 * 3. On a miss the build runs in a throwaway `REPO_SESSION` Durable Object,
 *    which stores the unsigned graph under the key. A build that exceeds
 *    the isolate's memory or CPU limits fails only its own request, with an
 *    error that names the packages.
 */
import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { z } from 'zod'
import {
	AuthorizationError,
	runWithRequestPermissions,
} from '#worker/authorization/authorize.ts'
import { loadPackageSourceRowForUser } from '#worker/package-registry/source.ts'
import { listPublishedBundleArtifactsBySourceId } from '#worker/repo/published-bundle-artifacts-repo.ts'
import { servingCommitForSource } from '#worker/repo/serving-commit.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	buildUnsignedLocalExecutePackageGraph,
	collectLocalExecutePackageGraphImports,
	emptyUnsignedLocalExecutePackageGraph,
	LocalExecutePackageGraphError,
	signLocalExecutePackageGraph,
	type LocalExecutePackageGraph,
	type UnsignedLocalExecutePackageGraph,
} from './local-execute-package-graph.ts'
import {
	parseKodyPackageSpecifier,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'

/** Bump when the unsigned graph shape changes. */
const cacheKeyVersion = 'v1'
const cacheKeyPrefix = `local-execute-package-graph:${cacheKeyVersion}:`
const cacheTtlSeconds = 7 * 24 * 60 * 60
/** KV values cap at 25 MiB; leave headroom for the JSON envelope. */
const maxCachedGraphBytes = 20 * 1024 * 1024

const unsignedGraphSchema = z.object({
	modules: z.array(z.object({ name: z.string(), esModule: z.string() })),
	primaryRuntimePath: z.string(),
	includesPrimaryRuntime: z.boolean(),
	imports: z.array(z.string()),
	packageIdsByImport: z.record(z.string(), z.string()),
	graphPackageIds: z.array(z.string()),
	entryPackageIds: z.array(z.string()),
	resolvedPackageIds: z.array(z.string()),
}) satisfies z.ZodType<UnsignedLocalExecutePackageGraph>

export type IsolatedLocalExecutePackageGraphRequest = {
	userId: OwnerId
	baseUrl: string
	code: string
	/** Caller identity; the isolate recomputes its permissions from it. */
	request: RequestContext | null
	/** Store the graph here when it only depends on the keyed packages. */
	cache: { key: string; packageIds: Array<string> } | null
}

export type IsolatedLocalExecutePackageGraphOutcome =
	| { ok: true; graph: UnsignedLocalExecutePackageGraph }
	| {
			ok: false
			kind: 'graph'
			code: LocalExecutePackageGraphError['code']
			message: string
	  }
	| {
			ok: false
			kind: 'authorization'
			error: ConstructorParameters<typeof AuthorizationError>[0]
	  }

type IsolatedLocalExecutePackageGraphStub = {
	buildIsolatedLocalExecutePackageGraph(
		input: IsolatedLocalExecutePackageGraphRequest,
	): Promise<IsolatedLocalExecutePackageGraphOutcome>
}

/**
 * Serve a signed package graph for `code`: from the cache when every direct
 * import's serving commit matches a stored build, else from a build in a
 * throwaway isolate. Call inside the request's permission scope
 * (`runWithRequestPermissions`) so direct imports are access-checked here.
 */
export async function serveLocalExecutePackageGraph(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	actorUserId: string | null
	code: string
	request: RequestContext | null
}): Promise<LocalExecutePackageGraph> {
	const { env } = input
	const subject = { org: input.userId, actor: input.actorUserId }
	const imports = collectLocalExecutePackageGraphImports(input.code)
	if (imports.length === 0) {
		return await signLocalExecutePackageGraph({
			env,
			graph: emptyUnsignedLocalExecutePackageGraph,
			subject,
		})
	}

	const cache = await resolvePackageGraphCacheKey({
		env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		imports,
	})
	if (cache) {
		const cached = await readCachedPackageGraph(env, cache.key)
		if (cached) {
			console.info('local-execute package graph cache hit', {
				userId: input.userId,
				imports: imports.length,
				modules: cached.modules.length,
			})
			return await signLocalExecutePackageGraph({
				env,
				graph: cached,
				subject,
			})
		}
	}

	console.info('local-execute package graph cache miss', {
		userId: input.userId,
		imports: imports.length,
		cacheable: cache != null,
	})
	const graph = await buildInThrowawayIsolate(env, {
		userId: input.userId,
		baseUrl: input.baseUrl,
		code: input.code,
		request: input.request,
		cache,
	})
	return await signLocalExecutePackageGraph({ env, graph, subject })
}

/**
 * Content address for the unsigned graph: org, base URL (baked into
 * rewritten modules), worker version (the rewrite code), and each direct
 * import's package id, serving commit, and artifact rows (a repair rebuilds
 * artifacts at the same commit; dependents of a changed dependency are
 * rebuilt too, so their rows change with it). Throws for an import that does
 * not resolve. Null when a package has no served commit yet; the build then
 * reports why.
 */
async function resolvePackageGraphCacheKey(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	imports: ReadonlyArray<string>
}): Promise<{ key: string; packageIds: Array<string> } | null> {
	const parts: Array<
		[string, string, string, string, Array<[string, string, string]>]
	> = []
	for (const specifier of input.imports) {
		const resolved = await resolveSavedPackageImport({
			db: input.env.APP_DB,
			userId: input.userId,
			specifier,
		})
		if (!resolved) {
			throw new LocalExecutePackageGraphError(
				'package_import_unresolved',
				`Could not resolve saved package import ${specifier} for local execute: no saved package named ${parseKodyPackageSpecifier(specifier).packageName} in this org.`,
			)
		}
		const source = await loadPackageSourceRowForUser({
			env: input.env,
			userId: input.userId,
			sourceId: resolved.row.sourceId,
		})
		const commit = servingCommitForSource(source)
		if (!commit) return null
		const artifacts = await listPublishedBundleArtifactsBySourceId(
			input.env.APP_DB,
			resolved.row.userId,
			resolved.row.sourceId,
		)
		parts.push([
			specifier,
			resolved.row.id,
			resolved.row.sourceId,
			commit,
			artifacts
				.map((artifact): [string, string, string] => [
					artifact.id,
					artifact.kvKey,
					artifact.updatedAt,
				])
				.sort(([left], [right]) => left.localeCompare(right)),
		])
	}
	parts.sort(([left], [right]) => left.localeCompare(right))
	const digest = await sha256Hex(
		JSON.stringify({
			version: cacheKeyVersion,
			workerVersion: input.env.CF_VERSION_METADATA?.id ?? null,
			userId: input.userId,
			baseUrl: input.baseUrl,
			packages: parts,
		}),
	)
	return {
		key: `${cacheKeyPrefix}${digest}`,
		packageIds: [...new Set(parts.map(([, packageId]) => packageId))],
	}
}

async function readCachedPackageGraph(env: Env, key: string) {
	const stored = await env.BUNDLE_ARTIFACTS_KV.get(key, 'json')
	if (stored == null) return null
	const parsed = unsignedGraphSchema.safeParse(stored)
	return parsed.success ? parsed.data : null
}

async function buildInThrowawayIsolate(
	env: Env,
	request: IsolatedLocalExecutePackageGraphRequest,
): Promise<UnsignedLocalExecutePackageGraph> {
	// A fresh, org-namespaced id per build puts it in its own isolate, never
	// the API isolate. The instance never touches its storage.
	const stub = env.REPO_SESSION.get(
		env.REPO_SESSION.idFromName(
			`isolated-package-graph-${request.userId}-${crypto.randomUUID()}`,
		),
	) as unknown as IsolatedLocalExecutePackageGraphStub
	let outcome: IsolatedLocalExecutePackageGraphOutcome
	try {
		outcome = await stub.buildIsolatedLocalExecutePackageGraph(request)
	} catch (error) {
		if (
			errorCauseChainIncludes(
				error,
				isDurableObjectIsolateResourceLimitResetMessage,
			)
		) {
			throw new LocalExecutePackageGraphError(
				'package_graph_resource_limit',
				packageGraphResourceLimitMessage(
					collectLocalExecutePackageGraphImports(request.code),
				),
				{ cause: error },
			)
		}
		throw error
	}
	if (outcome.ok) return outcome.graph
	if (outcome.kind === 'authorization') {
		throw new AuthorizationError(outcome.error)
	}
	throw new LocalExecutePackageGraphError(outcome.code, outcome.message)
}

/** Caller-facing copy when one isolated graph build hits its limits. */
export function packageGraphResourceLimitMessage(
	imports: ReadonlyArray<string>,
) {
	const packageNames = [
		...new Set(
			imports.map((specifier) => {
				try {
					return parseKodyPackageSpecifier(specifier).packageName
				} catch {
					return specifier
				}
			}),
		),
	]
	return (
		`Building the local execute package graph for ${packageNames.join(', ')} ` +
		"exceeded the isolated package graph builder's memory or CPU limits, " +
		'so only this request failed. ' +
		"The build loads each imported package's published modules, so its " +
		'cost grows with package size. Make the package smaller: list scripts, ' +
		'fixtures, generated or vendored code, and data files in a ' +
		'`.kodyignore` file next to package.json, split very large ' +
		'entrypoints, or drop heavy dependencies, then publish again. Import ' +
		'only the packages this run needs.'
	)
}

/**
 * The isolate side of {@link serveLocalExecutePackageGraph}: build the
 * unsigned graph under the caller's permissions and cache it when it only
 * depends on the keyed packages. Runs in `RepoSession`.
 */
export async function runIsolatedLocalExecutePackageGraphBuild(
	env: Env,
	request: IsolatedLocalExecutePackageGraphRequest,
): Promise<IsolatedLocalExecutePackageGraphOutcome> {
	let graph: UnsignedLocalExecutePackageGraph
	try {
		graph = await runWithRequestPermissions(
			{ env, request: request.request },
			() =>
				buildUnsignedLocalExecutePackageGraph({
					env,
					baseUrl: request.baseUrl,
					userId: request.userId,
					code: request.code,
				}),
		)
	} catch (error) {
		if (error instanceof LocalExecutePackageGraphError) {
			return {
				ok: false,
				kind: 'graph',
				code: error.code,
				message: error.message,
			}
		}
		if (error instanceof AuthorizationError) {
			return {
				ok: false,
				kind: 'authorization',
				error: {
					code: error.code,
					permission: error.permission,
					orgId: error.orgId,
					resource: error.resource,
					message: error.message,
					mintScopes: error.mintScopes,
				},
			}
		}
		throw error
	}
	if (request.cache) await cachePackageGraph(env, request.cache, graph)
	return { ok: true, graph }
}

async function cachePackageGraph(
	env: Env,
	cache: { key: string; packageIds: Array<string> },
	graph: UnsignedLocalExecutePackageGraph,
) {
	// A package resolved live beyond the keyed ones (a nested import with no
	// pinned artifact) can change without changing the key.
	const keyed = new Set(cache.packageIds)
	if (!graph.resolvedPackageIds.every((packageId) => keyed.has(packageId))) {
		return
	}
	const value = JSON.stringify(graph)
	if (value.length > maxCachedGraphBytes) return
	try {
		await env.BUNDLE_ARTIFACTS_KV.put(cache.key, value, {
			expirationTtl: cacheTtlSeconds,
		})
	} catch (error) {
		console.warn('local-execute package graph cache write failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

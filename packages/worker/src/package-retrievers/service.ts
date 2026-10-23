import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { inheritRequest } from '#worker/request-context/request-context.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { loadPublishedBundleArtifactByIdentity } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { isUnrepairablePreBindingArtifact } from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import { type PublishedBundleArtifact } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	type PackageRetrieverManifestCacheEntry,
	type PackageRetrieverResult,
	type PackageRetrieverScope,
	type PackageRetrieverSurfaceResult,
	packageRetrieverOutputSchema,
} from './types.ts'
import { listPackageRetrieversForScope } from './manifest-cache.ts'

const defaultSearchLimit = 5
const defaultContextLimit = 2
const maxSearchLimit = 20
const maxContextLimit = 3
// Retrievers are optional enrichment. Keep budgets bounded so a slow package
// cannot dominate search/execute wall time, while leaving context retrievers
// enough headroom for cold isolate + packageStorage work. Individual failures
// must not fail the tool.
const defaultSearchTimeoutMs = 3_000
const defaultContextTimeoutMs = 2_500
const maxSearchTimeoutMs = 5_000
const maxContextTimeoutMs = 3_000
const maxResultSummaryLength = 1_000
const maxResultDetailsLength = 4_000

function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

function buildPackageRetrieverStorageId(packageId: string) {
	// Names the package bucket (same shape as buildPackageStorageId). Since the
	// ambient `storage` binding was removed from retriever runs, this only
	// feeds `callerContext.storageContext` and runtime-debug metadata —
	// retriever code reaches the bucket via `packageStorage()`.
	return `package:${encodeURIComponent(packageId)}`
}

function clampLimit(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextLimit : defaultSearchLimit
	const max = scope === 'context' ? maxContextLimit : maxSearchLimit
	return Math.min(max, Math.max(1, value ?? fallback))
}

function clampTimeout(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextTimeoutMs : defaultSearchTimeoutMs
	const max = scope === 'context' ? maxContextTimeoutMs : maxSearchTimeoutMs
	return Math.min(max, Math.max(1, value ?? fallback))
}

function truncate(value: string | undefined, maxLength: number) {
	if (value === undefined) return undefined
	return value.length <= maxLength ? value : value.slice(0, maxLength)
}

function normalizeRetrieverResults(input: {
	entry: PackageRetrieverManifestCacheEntry
	results: Array<PackageRetrieverResult>
}): Array<PackageRetrieverSurfaceResult> {
	return input.results.map((result) => ({
		...result,
		summary: truncate(result.summary, maxResultSummaryLength) ?? '',
		details: truncate(result.details, maxResultDetailsLength),
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		retrieverKey: input.entry.retrieverKey,
		retrieverName: input.entry.name,
	}))
}

/**
 * A stored retriever bundle built before package `fetch` became lexical that
 * inlines other packages cannot be bound in place (GHSA-5fv3-qv7j-rqf5): an
 * inlined dependency's `packageStorage()` or `fetch` would act as the
 * retriever's package. Send it through the shared module-artifact load site,
 * which rebuilds it from source (or keeps serving it and logs
 * `pre_binding_bundle_needs_republish` when the source needs an npm
 * install), the same as exports, subscriptions, and workflow steps.
 */
async function resolveRunnableRetrieverArtifact(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
	exportName: string
	artifact: PublishedBundleArtifact
}): Promise<PublishedBundleArtifact> {
	if (!isUnrepairablePreBindingArtifact(input.artifact)) return input.artifact
	const { ensureModuleArtifact } =
		await import('#worker/package-invocations/module-artifacts.ts')
	const ensured = await ensureModuleArtifact({
		env: input.env,
		baseUrl: input.baseUrl,
		savedPackage: input.savedPackage,
		selector: { kind: 'export', exportName: input.exportName },
		userId: input.userId,
	})
	return ensured.artifact
}

async function invokeRetriever(input: {
	env: Env
	baseUrl: string
	userId: string
	request: RequestContext
	scope: PackageRetrieverScope
	entry: PackageRetrieverManifestCacheEntry
	query: string
	includeHiddenPackages: boolean
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.entry.packageId,
	})
	if (!savedPackage) {
		return []
	}
	// Hidden gating is a search-discovery preference only. Context retrievers
	// (memory/tool context) must still run for hidden packages.
	if (
		input.scope === 'search' &&
		savedPackage.hidden &&
		!input.includeHiddenPackages
	) {
		return []
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.entry.sourceId,
	)
	if (
		!source ||
		!source.published_commit ||
		source.published_commit !== input.entry.revision
	) {
		return []
	}
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.entry.sourceId,
		kind: 'module',
		artifactName: input.entry.exportName,
		entryPoint: input.entry.entryPoint,
	})
	if (!loaded?.artifact) {
		return []
	}
	const artifact = await resolveRunnableRetrieverArtifact({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage,
		exportName: input.entry.exportName,
		artifact: loaded.artifact,
	})
	const limit = clampLimit(input.entry.maxResults, input.scope)
	const callerContext = createMcpCallerContext({
		baseUrl: input.baseUrl,
		executionOrigin: 'background',
		user: await resolveBackgroundMcpUser(input.env.APP_DB, input.userId),
		storageContext: {
			sessionId: null,
			appId: input.entry.packageId,
			packageId: input.entry.packageId,
			storageId: buildPackageRetrieverStorageId(input.entry.packageId),
		},
		repoContext: createRepoContext(source),
		source: inheritRequest(input.request),
	})
	const packageContext = {
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		sourceId: input.entry.sourceId,
	}
	const runRecord = {
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		sourceId: input.entry.sourceId,
		publishedCommit: source.published_commit,
		surface: 'retriever' as const,
		name: input.entry.retrieverKey,
		storageId: buildPackageRetrieverStorageId(input.entry.packageId),
		metadata: {
			scope: input.scope,
			limit,
		},
	}
	const executionResult = await runBundledModuleWithRegistry(
		input.env,
		callerContext,
		{
			mainModule: artifact.mainModule,
			modules: artifact.modules,
			dependencies: artifact.dependencies,
			...(artifact.packageBindingRewrite === undefined
				? {}
				: { packageBindingRewrite: artifact.packageBindingRewrite }),
		},
		{
			query: input.query,
			scope: input.scope,
			memoryContext: input.memoryContext ?? null,
			limit,
			conversationId: input.conversationId ?? null,
		},
		{
			// Retrievers enrich search/context. The closed-world profile is a
			// runtime constraint: read-only packageStorage, no capability map,
			// no invoke/events/workflows, no outbound fetch.
			packageContext,
			runRecord,
			closedWorldRetrieverRuntime: true,
			executorTimeoutMs: clampTimeout(input.entry.timeoutMs, input.scope),
			waitUntil: input.waitUntil,
		},
	)
	if (executionResult.error) {
		throw new Error(getErrorMessage(executionResult.error))
	}
	const parsed = packageRetrieverOutputSchema.safeParse(executionResult.result)
	if (!parsed.success) {
		throw new Error(
			`Retriever "${input.entry.retrieverKey}" returned an invalid result shape.`,
		)
	}
	return normalizeRetrieverResults({
		entry: input.entry,
		results: parsed.data.results.slice(0, limit),
	})
}

async function loadScopeEntries(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
}) {
	return (await listPackageRetrieversForScope(input))
		.filter((entry) => entry.scopes.includes(input.scope))
		.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.retrieverKey.localeCompare(right.retrieverKey),
		)
}

export async function runPackageRetrievers(input: {
	env: Env
	baseUrl: string
	userId: string | null
	/** The searching caller; retrievers run as part of its request. */
	request: RequestContext | null
	scope: PackageRetrieverScope
	query: string
	includeHiddenPackages?: boolean
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
	maxProviders?: number
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const userId = input.userId?.trim()
	const query = input.query.trim()
	const includeHiddenPackages = !!input.includeHiddenPackages
	const request = input.request
	if (!userId || !request || !query) {
		return {
			results: [],
			warnings: [],
		}
	}
	if (!('BUNDLE_ARTIFACTS_KV' in input.env)) {
		throw new Error(
			'BUNDLE_ARTIFACTS_KV binding is required for package retrievers.',
		)
	}
	const entries = (
		await loadScopeEntries({
			env: input.env,
			userId,
			scope: input.scope,
		})
	).slice(0, input.maxProviders ?? (input.scope === 'context' ? 3 : 10))
	// Soft-fail per retriever: one stalled/buggy package must not fail MCP
	// `search` or pre-sandbox execute memory/context enrichment. Callers already
	// surface `warnings` to agents. This wrap creates a request budget only
	// when the caller has not already opened one — sibling retriever waves in
	// the same request (search + memory) must share that outer budget.
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				entries.map((entry) =>
					invokeRetriever({
						env: input.env,
						baseUrl: input.baseUrl,
						userId,
						request,
						scope: input.scope,
						entry,
						query,
						includeHiddenPackages,
						memoryContext: input.memoryContext,
						conversationId: input.conversationId,
						waitUntil: input.waitUntil,
					}),
				),
			),
	)
	const results: Array<PackageRetrieverSurfaceResult> = []
	const warnings: Array<string> = []
	for (let index = 0; index < settled.length; index += 1) {
		const outcome = settled[index]
		const entry = entries[index]
		if (!outcome || !entry) continue
		if (outcome.status === 'fulfilled') {
			results.push(...outcome.value)
			continue
		}
		const reason = getErrorMessage(outcome.reason)
		console.error(
			JSON.stringify({
				message: 'package retriever failed',
				packageId: entry.packageId,
				kodyId: entry.kodyId,
				retrieverKey: entry.retrieverKey,
				scope: input.scope,
				reason,
			}),
		)
		warnings.push(
			`Package retriever "${entry.kodyId}/${entry.retrieverKey}" failed and was skipped: ${reason}`,
		)
	}
	return {
		results: results.sort(
			(left, right) => (right.score ?? 0) - (left.score ?? 0),
		),
		warnings,
	}
}

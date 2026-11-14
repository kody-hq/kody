import { toServingSourceView } from '#worker/repo/serving-commit.ts'

import {
	isUnrepairablePreBindingArtifact,
	publishedArtifactNeedsPackageBindingRebuild,
} from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import { resolveSavedPackageRef } from '#worker/package-registry/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	loadPackageManifestForSource,
	type loadPackageSourceBySourceId,
	loadServingPackageSourceBySourceId,
	loadPackageSourceRowForUser,
	type LoadedPackageManifest,
} from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { checkPublishedEntrypointsForRebuild } from '#worker/repo/published-entrypoint-checks.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	assertPublishedSourceCanRebuildWithoutInstallingDeps,
	canKeepPreviousNpmBundleDuringRebuild,
	isPublishedRuntimeBundleMissingError,
	listMissingPublishedSourceInstalledDependencies,
} from '#worker/package-runtime/published-source-dependencies.ts'
import {
	buildPackageSubscriptionArtifactName,
	normalizePackageSubscriptionTopic,
} from '#worker/package-runtime/subscription-artifacts.ts'
import {
	parseKodyPackageSpecifier,
	resolveSavedPackageImport,
} from '#worker/package-runtime/package-import-resolution.ts'
import { buildPackageSubscriptionNotFoundMessage } from './subscription-envelope.ts'
import {
	normalizeExportName,
	type PackageModuleResolution,
	type PackageModuleSelector,
} from './common.ts'
import {
	loadModuleArtifactWithCommitCache,
	loadSourceRowWithFreshnessCache,
	resolvePackageAppSlugWithFreshnessCache,
	resolveSavedPackageWithFreshnessCache,
	type CachedInvokeModuleArtifact,
	type PackageAppSlugLookup,
} from './invoke-contract-cache.ts'
import type { PublishedBundleArtifact } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import {
	errorCauseChainIncludes,
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import {
	getRequestPermissions,
	runWithBoundPermissions,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { isMcpCallerError, McpCallerError } from '#mcp/caller-error.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import { publishOutsideCloudAdvice } from '#worker/repo/isolated-runner-limit-message.ts'

export async function resolveSavedPackage(input: {
	db: D1Database
	userId: string
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord | null> {
	return await resolveSavedPackageWithFreshnessCache({
		userId: input.userId,
		packageIdOrKodyId: input.packageIdOrKodyId,
		load: async () =>
			await resolveSavedPackageRef(input.db, {
				userId: input.userId,
				ref: input.packageIdOrKodyId,
			}),
	})
}

/**
 * Package-app host resolution: follow slug redirects and report whether the
 * URL slug is retired so the host can permanent-308 to the canonical path.
 * Live-only {@link resolveSavedPackage} stays redirect-blind for invoke paths.
 */
export async function resolveSavedPackageForPackageAppSlug(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<PackageAppSlugLookup | null> {
	return await resolvePackageAppSlugWithFreshnessCache({
		userId: input.userId,
		slug: input.slug,
		load: async () => {
			const savedPackage = await resolveSavedPackageRef(input.db, {
				userId: input.userId,
				ref: input.slug,
				match: 'slug',
				followRedirects: true,
			})
			if (!savedPackage) return null
			return {
				savedPackage,
				retired: getPackageNameLeaf(savedPackage.name) !== input.slug,
			}
		},
	})
}

export async function resolveSavedPackageBySpecifier(input: {
	db: D1Database
	userId: string
	specifier: string
}): Promise<SavedPackageRecord | null> {
	const parsed = parseKodyPackageSpecifier(input.specifier)
	const cacheKey = `kody:${parsed.packageName}`
	return await resolveSavedPackageWithFreshnessCache({
		userId: input.userId,
		packageIdOrKodyId: cacheKey,
		load: async () =>
			(
				await resolveSavedPackageImport({
					db: input.db,
					userId: input.userId,
					specifier: parsed,
				})
			)?.row ?? null,
	})
}

/**
 * Manifest load for invocation paths: the entity-source row (the freshness
 * anchor carrying `published_commit`) comes from the short-TTL invoke
 * contract cache, and the manifest itself from the commit-keyed manifest
 * cache. Warm calls perform zero D1/KV loads. Publish and rebuild flows must
 * keep using `loadPackageManifestBySourceId`, which always reads the row
 * fresh. Package-app HTTP serve is an invocation hot path and uses this
 * loader; do not switch it back to the uncached source-row read.
 */
export async function loadInvokeManifestBySourceId(input: {
	env: Env
	userId: string
	sourceId: string
}): Promise<LoadedPackageManifest> {
	const source = await loadSourceRowWithFreshnessCache({
		userId: input.userId,
		sourceId: input.sourceId,
		load: () =>
			loadPackageSourceRowForUser({
				env: input.env,
				userId: input.userId,
				sourceId: input.sourceId,
			}),
	})
	return await loadPackageManifestForSource({
		env: input.env,
		userId: input.userId,
		source: toServingSourceView(source),
	})
}

export async function ensureModuleArtifact(input: {
	env: Env
	baseUrl: string
	packageManifest?: LoadedPackageManifest
	resolution?: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}): Promise<CachedInvokeModuleArtifact> {
	const packageManifest =
		input.packageManifest ??
		(await loadInvokeManifestBySourceId({
			env: input.env,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		}))
	const resolution =
		input.resolution ??
		resolvePackageModuleResolution({
			manifest: packageManifest.manifest,
			selector: input.selector,
		})
	return await loadModuleArtifactWithCommitCache({
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		publishedCommit: packageManifest.source.published_commit,
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
		load: () =>
			ensureModuleArtifactUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				packageManifest,
				resolution,
				savedPackage: input.savedPackage,
				selector: input.selector,
				userId: input.userId,
			}),
	})
}

async function ensureModuleArtifactUncached(input: {
	env: Env
	baseUrl: string
	packageManifest: LoadedPackageManifest
	resolution: PackageModuleResolution
	savedPackage: SavedPackageRecord
	selector: PackageModuleSelector
	userId: string
}): Promise<CachedInvokeModuleArtifact> {
	const { packageManifest, resolution } = input
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
		commit: packageManifest.source.published_commit,
	})
	const currentPublishedCommit = packageManifest.source.published_commit
	const currentArtifact =
		loaded?.artifact &&
		loaded.artifact.publishedCommit === currentPublishedCommit &&
		loaded.row.publishedCommit === currentPublishedCommit
			? loaded.artifact
			: null
	// A pre-fix bundle that inlines other packages may need one rebuild so
	// each package's fetch acts as that package (GHSA-5fv3-qv7j-rqf5).
	const mayNeedBindingRebuild =
		currentArtifact != null && isUnrepairablePreBindingArtifact(currentArtifact)
	if (currentArtifact && !mayNeedBindingRebuild) {
		return {
			artifact: currentArtifact,
			source: packageManifest.source,
			entryPoint: resolution.entryPoint,
		}
	}
	const rebuild = await rebuildModuleArtifactInIsolate(input.env, {
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage: {
			id: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
		selector: input.selector,
		publishedCommit: currentPublishedCommit,
		artifactName: resolution.artifactName,
		entryPoint: resolution.entryPoint,
		hasCurrentArtifact: currentArtifact != null,
		hasStoredArtifact: loaded?.artifact != null,
		permissions: getRequestPermissions(),
	})
	const moduleLabel =
		input.selector.kind === 'export'
			? `export "${input.selector.exportName}"`
			: `subscription "${input.selector.topic}"`
	if (rebuild.serve === 'previous') {
		if (!loaded?.artifact) {
			throw new Error(
				`Published bundle artifact for ${moduleLabel} could not be loaded after rebuild.`,
			)
		}
		return {
			artifact: loaded.artifact,
			source: rebuild.source,
			entryPoint: loaded.artifact.entryPoint,
		}
	}
	// Serve the artifact the isolate checked or stored, not this isolate's
	// earlier read of the same commit-keyed entry: that read may be a
	// pre-binding bundle another run has since repaired, or a miss this
	// location still caches.
	return {
		artifact: rebuild.artifact,
		source:
			rebuild.serve === 'current' ? packageManifest.source : rebuild.source,
		entryPoint:
			rebuild.serve === 'current' ? resolution.entryPoint : rebuild.entryPoint,
	}
}

type ModuleArtifactSource = CachedInvokeModuleArtifact['source']

export type IsolatedModuleArtifactRebuildRequest = {
	baseUrl: string
	userId: string
	savedPackage: Pick<SavedPackageRecord, 'id' | 'kodyId' | 'sourceId'>
	selector: PackageModuleSelector
	/** The commit, artifact name, and entry point the caller resolved. */
	publishedCommit: string | null
	artifactName: string
	entryPoint: string
	/** The caller holds a same-commit artifact that may predate bindings. */
	hasCurrentArtifact: boolean
	/** The caller holds an artifact of any commit it can keep serving. */
	hasStoredArtifact: boolean
	/** The caller's permission binding, rebound around the rebuild. */
	permissions: EffectivePermissions | undefined
}

/**
 * What the caller serves: the same-commit artifact the isolate found to need
 * no rebuild, the caller's own previous-commit artifact, or the one this
 * rebuild just stored.
 */
export type ModuleArtifactRebuildResult =
	| { serve: 'current'; artifact: PublishedBundleArtifact }
	| { serve: 'previous'; source: ModuleArtifactSource }
	| {
			serve: 'rebuilt'
			artifact: PublishedBundleArtifact
			source: ModuleArtifactSource
			entryPoint: string
	  }

export type IsolatedModuleArtifactRebuildOutcome =
	| { ok: true; result: ModuleArtifactRebuildResult }
	| {
			ok: false
			name: string
			/** The error's message, then each cause's, outermost first. */
			messages: Array<string>
			callerError: boolean
	  }

type IsolatedModuleArtifactRebuildStub = {
	rebuildIsolatedModuleArtifact(
		input: IsolatedModuleArtifactRebuildRequest,
	): Promise<IsolatedModuleArtifactRebuildOutcome>
}

/**
 * Rebuild a missing or outdated module artifact in a throwaway isolate. The
 * rebuild loads the package's whole source and bundles it, which can exceed
 * an isolate's limits; in the calling isolate that would also kill every
 * other job, webhook, and request sharing it.
 */
async function rebuildModuleArtifactInIsolate(
	env: Env,
	request: IsolatedModuleArtifactRebuildRequest,
): Promise<ModuleArtifactRebuildResult> {
	// A fresh, org-namespaced id per rebuild puts it in its own isolate. The
	// instance never touches its storage.
	const stub = env.REPO_SESSION.get(
		env.REPO_SESSION.idFromName(
			`isolated-module-artifact-rebuild-${request.userId}-${crypto.randomUUID()}`,
		),
	) as unknown as IsolatedModuleArtifactRebuildStub
	let outcome: IsolatedModuleArtifactRebuildOutcome
	try {
		outcome = await stub.rebuildIsolatedModuleArtifact(request)
	} catch (error) {
		if (
			errorCauseChainIncludes(
				error,
				isDurableObjectIsolateResourceLimitResetMessage,
			)
		) {
			// No `cause`: the reset text reads as a retryable storage error, and
			// a retry would rebuild the same package into the same limit.
			throw new Error(
				`Rebuilding the stored bundle for "${request.artifactName}" exceeded ` +
					"the isolated rebuild runner's memory or CPU limits, so only this " +
					'run failed and it will fail the same way until the package is ' +
					`published again. ${publishOutsideCloudAdvice()}`,
			)
		}
		throw error
	}
	if (outcome.ok) return outcome.result
	// Rebuild the cause chain so retry classification reads it as before.
	const [message = 'Module artifact rebuild failed.', ...causeMessages] =
		outcome.messages
	const cause = causeMessages.reduceRight<Error | undefined>(
		(inner, causeMessage) => new Error(causeMessage, { cause: inner }),
		undefined,
	)
	const error = outcome.callerError
		? new McpCallerError(message, { cause })
		: new Error(message, { cause })
	error.name = outcome.name
	throw error
}

/** The isolate side of {@link rebuildModuleArtifactInIsolate}. Runs in `RepoSession`. */
export async function runIsolatedModuleArtifactRebuild(
	env: Env,
	request: IsolatedModuleArtifactRebuildRequest,
): Promise<IsolatedModuleArtifactRebuildOutcome> {
	try {
		const result = await runWithBoundPermissions(request.permissions, () =>
			rebuildModuleArtifact({ env, ...request }),
		)
		return { ok: true, result }
	} catch (error) {
		// Error classes do not survive the RPC boundary; carry what callers read.
		return {
			ok: false,
			name: error instanceof Error ? error.name : 'Error',
			messages: getErrorCauseChain(error).map(getErrorMessage),
			callerError: isMcpCallerError(error),
		}
	}
}

async function rebuildModuleArtifact(
	input: { env: Env } & IsolatedModuleArtifactRebuildRequest,
): Promise<ModuleArtifactRebuildResult> {
	const loaded = input.hasCurrentArtifact
		? await loadPublishedBundleArtifactByIdentity({
				env: input.env,
				userId: input.userId,
				sourceId: input.savedPackage.sourceId,
				kind: 'module',
				artifactName: input.artifactName,
				entryPoint: input.entryPoint,
				commit: input.publishedCommit,
			})
		: null
	const currentArtifact =
		loaded?.artifact &&
		loaded.artifact.publishedCommit === input.publishedCommit &&
		loaded.row.publishedCommit === input.publishedCommit
			? loaded.artifact
			: null
	const packageSource = await loadServingPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	if (
		currentArtifact &&
		!publishedArtifactNeedsPackageBindingRebuild({
			artifact: currentArtifact,
			sourceFiles: packageSource.files,
		})
	) {
		return { serve: 'current', artifact: currentArtifact }
	}
	// The caller's manifest may come from the freshness-cached source row and
	// trail a republish by up to the freshness TTL, while the source load
	// above is always current. Re-derive the module resolution from the
	// freshly loaded manifest so the entrypoint check, bundle, and persisted
	// artifact identity are all self-consistent with the commit being built.
	const freshResolution = resolvePackageModuleResolution({
		manifest: packageSource.manifest,
		selector: input.selector,
	})
	// External publish flips `published_commit` before the per-target rebuild
	// finishes. Invoke-contract-cache already serves a cross-commit identity
	// hit without retaining it; do the same here when source cannot rebuild
	// (npm deps live only in the published runtime bundle), and only while
	// the published snapshot `createdAt` (the finalize clock) is still inside
	// the rebuild window — or is unknown. A null clock is the finalize race
	// (`published_commit` flipped before `writePublishedSourceSnapshot`) and
	// Artifacts backfill (intentional: backfill is not a publish clock).
	// `entity_sources.updated_at` is the wrong clock: any later row write
	// would reopen stale serving. After the window the missing-bundle error
	// is retryable so a failed rebuild stays visible.
	if (
		listMissingPublishedSourceInstalledDependencies(packageSource.files)
			.length > 0
	) {
		if (
			input.hasStoredArtifact &&
			canKeepPreviousNpmBundleDuringRebuild({
				publishedAt: packageSource.snapshotCreatedAt,
			})
		) {
			return { serve: 'previous', source: packageSource.source }
		}
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles: packageSource.files,
			bundleLabel: `Saved package export "${freshResolution.artifactName}"`,
		})
	}
	// Invocation trusts what publish accepted: no typecheck here, only the
	// structural preconditions execution needs anyway.
	const entrypointCheck = checkPublishedEntrypointsForRebuild({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: freshResolution.entryPoint }],
	})
	if (!entrypointCheck.ok) {
		throw new Error(entrypointCheck.message)
	}
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
	const bundle = await buildKodyModuleBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: packageSource.files,
		entryPoint: freshResolution.entryPoint,
		rootPackageId: input.savedPackage.id,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: packageSource.source,
		kind: 'module',
		artifactName: freshResolution.artifactName,
		entryPoint: freshResolution.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		dynamicDependencies: bundle.dynamicDependencies,
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
	})
	const rebuilt = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'module',
		artifactName: freshResolution.artifactName,
		entryPoint: freshResolution.entryPoint,
		commit: packageSource.source.published_commit,
	})
	if (!rebuilt?.artifact) {
		const moduleLabel =
			input.selector.kind === 'export'
				? `export "${input.selector.exportName}"`
				: `subscription "${input.selector.topic}"`
		throw new Error(
			`Published bundle artifact for ${moduleLabel} could not be loaded after rebuild.`,
		)
	}
	return {
		serve: 'rebuilt',
		artifact: rebuilt.artifact,
		source: packageSource.source,
		entryPoint: freshResolution.entryPoint,
	}
}

export function resolvePackageModuleResolution(input: {
	manifest: Awaited<ReturnType<typeof loadPackageSourceBySourceId>>['manifest']
	selector: PackageModuleSelector
}): PackageModuleResolution {
	switch (input.selector.kind) {
		case 'export': {
			const exportName = normalizeExportName(input.selector.exportName)
			return {
				artifactName: exportName,
				entryPoint: resolvePackageExportPath({
					manifest: input.manifest,
					exportName,
				}),
			}
		}
		case 'subscription': {
			const topic = normalizePackageSubscriptionTopic(input.selector.topic)
			const handler = input.manifest.kody.subscriptions?.[topic]?.handler
			if (!handler) {
				throw new Error(
					buildPackageSubscriptionNotFoundMessage({
						kodyId: input.manifest.kody.id,
						topic,
					}),
				)
			}
			return {
				artifactName: buildPackageSubscriptionArtifactName(topic),
				entryPoint: normalizePackageWorkspacePath(handler),
			}
		}
		default: {
			const selector: never = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

export function isMissingPackageModuleError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('does not define export') ||
			error.message.includes('does not define a runtime target') ||
			error.message.includes('does not define subscription') ||
			error.message.includes('does not declare subscription'))
	)
}

export function isTransientModuleArtifactError(error: unknown) {
	if (isRetryableD1LockError(error)) return true
	if (isPublishedRuntimeBundleMissingError(error)) return true
	if (!(error instanceof Error)) return false
	return /(?:\bD1\b|\bKV\b|bindings? (?:are|is) not available|timeout|temporar|network|fetch|could not be loaded after rebuild)/i.test(
		error.message,
	)
}

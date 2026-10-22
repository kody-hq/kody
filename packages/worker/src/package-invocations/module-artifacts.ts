import {
	isPreBindingPublishedArtifact,
	publishedArtifactInlinesOtherPackages,
	publishedArtifactNeedsPackageBindingRebuild,
} from '#worker/package-runtime/pre-binding-artifact-repair.ts'
import { resolveSavedPackageRef } from '#worker/package-registry/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceBySourceId,
	loadPackageSourceRowForUser,
	type LoadedPackageManifest,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
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
import { isRetryableD1LockError } from '#worker/d1-retry.ts'

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
		source,
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
		currentArtifact != null &&
		isPreBindingPublishedArtifact(currentArtifact) &&
		publishedArtifactInlinesOtherPackages(currentArtifact)
	if (currentArtifact && !mayNeedBindingRebuild) {
		return {
			artifact: currentArtifact,
			source: packageManifest.source,
			entryPoint: resolution.entryPoint,
		}
	}
	const packageSource = await loadPackageSourceBySourceId({
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
		return {
			artifact: currentArtifact,
			source: packageManifest.source,
			entryPoint: resolution.entryPoint,
		}
	}
	// The caller's manifest may come from the freshness-cached source row and
	// trail a republish by up to the freshness TTL, while the source load
	// above is always current. Re-derive the module resolution from the
	// freshly loaded manifest so the typecheck, bundle, and persisted
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
			loaded?.artifact &&
			canKeepPreviousNpmBundleDuringRebuild({
				publishedAt: packageSource.snapshotCreatedAt,
			})
		) {
			return {
				artifact: loaded.artifact,
				source: packageSource.source,
				entryPoint: loaded.artifact.entryPoint,
			}
		}
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles: packageSource.files,
			bundleLabel: `Saved package export "${freshResolution.artifactName}"`,
		})
	}
	const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: packageSource.files,
		entryPoints: [{ path: freshResolution.entryPoint }],
		emittedEventTopics: Object.keys(packageSource.manifest.kody.emits ?? {}),
	})
	if (!typecheckResult.ok) {
		throw new Error(typecheckResult.message)
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

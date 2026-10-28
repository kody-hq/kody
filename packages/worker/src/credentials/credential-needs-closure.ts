/**
 * Computing, storing, and loading a package's credential needs closure
 * (ADR 0068). Publish computes it from the package's own needs and the
 * closures of the packages it statically imports, then stores it keyed by
 * source and published commit.
 */
import * as Sentry from '@sentry/cloudflare'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import {
	readPublishedCredentialNeeds,
	readPublishedSourceSnapshot,
	writePublishedCredentialNeeds,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import {
	getEntitySourceById,
	listEntitySourcesByIds,
} from '#worker/repo/entity-sources.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { isPackageCredentialSuppliersEnabled } from './credential-suppliers-flag.ts'
import {
	mergeCredentialNeeds,
	ownCredentialNeeds,
	readStoredCredentialNeeds,
	type CredentialNeed,
	type DependencyCredentialNeeds,
} from './credential-needs.ts'

/**
 * The package's files relative to its source root, plus its manifest.
 * Repo-session snapshots key files from the repo root; check results key them
 * from the source root. Both shapes reach publish.
 */
export function packageSourceFiles(input: {
	source: Pick<EntitySourceRow, 'manifest_path' | 'source_root'>
	files: Record<string, string>
}) {
	const root = normalizeRepoWorkspacePath(input.source.source_root).replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeRepoWorkspacePath(input.source.manifest_path)
	const prefix = `${root}/`
	if (root && manifestPath.startsWith(prefix)) {
		const relativeManifest = manifestPath.slice(prefix.length)
		if (typeof input.files[input.source.manifest_path] === 'string') {
			const files = Object.fromEntries(
				Object.entries(input.files)
					.map(
						([path, content]) =>
							[normalizeRepoWorkspacePath(path), content] as const,
					)
					.filter(([path]) => path.startsWith(prefix))
					.map(([path, content]) => [path.slice(prefix.length), content]),
			)
			return { files, manifestContent: files[relativeManifest] ?? null }
		}
		return {
			files: input.files,
			manifestContent: input.files[relativeManifest] ?? null,
		}
	}
	return {
		files: input.files,
		manifestContent: input.files[input.source.manifest_path] ?? null,
	}
}

/**
 * The closure a published package carries: the one stored at its publish.
 * A publish that stored none (an older publish, or a path that skipped it) is
 * computed from its published source. `visiting` breaks import cycles.
 *
 * `fresh` skips this package's stored closure and recomputes it from its own
 * needs and its imports' current closures, which picks up needs a dependency
 * declared after this package last published.
 */
export async function loadPublishedCredentialNeeds(input: {
	env: Env
	userId: string
	sourceId: string
	/**
	 * Preloaded entity-source row (same freshness as a direct
	 * {@link getEntitySourceById}). Callers that already batched
	 * `listEntitySourcesByIds` pass the row so the gateway path does not
	 * re-query. Omit to read from D1.
	 */
	source?: EntitySourceRow | null
	visiting?: ReadonlySet<string>
	fresh?: boolean
	supplierSemanticsEnabled?: boolean
	request?: object | null
}): Promise<Array<CredentialNeed>> {
	const visiting = input.visiting ?? new Set<string>()
	if (visiting.has(input.sourceId)) return []
	const source =
		input.source !== undefined
			? input.source
			: await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (
		!source ||
		source.id !== input.sourceId ||
		!source.published_commit ||
		source.user_id !== input.userId
	) {
		return []
	}
	const supplierSemanticsEnabled =
		input.supplierSemanticsEnabled ??
		(await isPackageCredentialSuppliersEnabled({
			db: input.env.APP_DB,
			orgId: input.userId,
			request: input.request,
		}))
	const stored = input.fresh
		? null
		: readStoredCredentialNeeds(
				await readPublishedCredentialNeeds({
					env: input.env,
					sourceId: source.id,
					publishedCommit: source.published_commit,
				}),
				{ supplierSemanticsEnabled },
			)
	if (stored) return stored
	const { manifest } = await loadPublishedEntityManifest({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
		source,
	})
	const snapshot = await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit: source.published_commit,
	})
	if (!snapshot) {
		return ownCredentialNeeds(manifest.kody.credentials, {
			supplierSemanticsEnabled,
		})
	}
	const { needs } = await computeCredentialNeedsClosure({
		env: input.env,
		userId: input.userId,
		manifest,
		files: packageSourceFiles({ source, files: snapshot.files }).files,
		visiting: new Set([...visiting, source.id]),
		supplierSemanticsEnabled,
		request: input.request,
	})
	return needs
}

/**
 * Each statically imported package's current closure, which is what the
 * dependent's bundle snapshots. A package that is not in this org is left to
 * the bundle check, which reports it; any other failure throws, so a partial
 * closure is never stored.
 *
 * Resolves every import name first, then loads all entity-source rows in one
 * `IN (…)` (KODY-AK). Awaiting `resolveSavedPackageImport` before each
 * `getEntitySourceById` used to defeat the microtask batcher and leave an N+1
 * on KodyFetchGateway credential-need checks.
 */
async function loadDependencyCredentialNeeds(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
	visiting: ReadonlySet<string>
	supplierSemanticsEnabled: boolean
	request?: object | null
}): Promise<Array<DependencyCredentialNeeds>> {
	const names = [
		...new Set(
			collectStaticKodyPackageImportsFromFiles(input.files)
				.map((imported) => imported.packageName)
				.filter((name) => name !== input.manifest.name),
		),
	].sort()
	const resolutions = await Promise.all(
		names.map(async (packageName) => {
			const resolution = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.userId,
				specifier: { packageName, exportName: '.' },
			})
			if (!resolution) return null
			return { packageName, resolution }
		}),
	)
	const found = resolutions.filter(
		(entry): entry is NonNullable<typeof entry> => entry !== null,
	)
	if (found.length === 0) return []
	const sourceIds = found.map(({ resolution }) => resolution.row.sourceId)
	const [singleId] = sourceIds
	const sourceRows =
		sourceIds.length === 1 && singleId
			? await getEntitySourceById(input.env.APP_DB, singleId).then((row) =>
					row ? [row] : [],
				)
			: await listEntitySourcesByIds(input.env.APP_DB, sourceIds)
	const sourcesById = new Map(sourceRows.map((row) => [row.id, row]))
	const dependencies = await Promise.all(
		found.map(async ({ packageName, resolution }) => {
			const needs = await loadPublishedCredentialNeeds({
				env: input.env,
				userId: resolution.row.userId,
				sourceId: resolution.row.sourceId,
				source: sourcesById.get(resolution.row.sourceId) ?? null,
				visiting: input.visiting,
				supplierSemanticsEnabled: input.supplierSemanticsEnabled,
				request: input.request,
			})
			return { packageName, needs }
		}),
	)
	return dependencies
}

/** `files` are relative to the package's source root. */
export async function computeCredentialNeedsClosure(input: {
	env: Env
	userId: string
	manifest: AuthoredPackageJson
	files: Record<string, string>
	visiting?: ReadonlySet<string>
	supplierSemanticsEnabled?: boolean
	request?: object | null
}) {
	const supplierSemanticsEnabled =
		input.supplierSemanticsEnabled ??
		(await isPackageCredentialSuppliersEnabled({
			db: input.env.APP_DB,
			orgId: input.userId,
			request: input.request,
		}))
	const merged = mergeCredentialNeeds({
		own: ownCredentialNeeds(input.manifest.kody.credentials, {
			supplierSemanticsEnabled,
		}),
		dependencies: await loadDependencyCredentialNeeds({
			...input,
			visiting: input.visiting ?? new Set(),
			supplierSemanticsEnabled,
			request: input.request,
		}),
		supplierSemanticsEnabled,
	})
	if (!supplierSemanticsEnabled) return merged
	const publisherKeys = new Set(
		merged.needs
			.filter((need) => need.supplier === 'publisher')
			.map((need) => need.key),
	)
	const visitorNeedConflicts = Object.entries(
		input.manifest.kody.app?.visitorNeeds ?? {},
	).flatMap(([visitorNeedKey, visitorNeed]) =>
		visitorNeed.credential && publisherKeys.has(visitorNeed.credential)
			? [
					`kody.app.visitorNeeds.${visitorNeedKey} cannot reference publisher-supplied credential need "${visitorNeed.credential}".`,
				]
			: [],
	)
	return {
		...merged,
		conflicts: [...merged.conflicts, ...visitorNeedConflicts],
	}
}

/**
 * Stores the closure for one package publish. Best effort: a publish whose
 * closure was not stored is computed from its source when read, so a failure
 * here never fails the publish. Conflicts were refused by checks.
 */
export async function storePublishedCredentialNeeds(input: {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	files: Record<string, string>
}) {
	if (input.source.entity_kind !== 'package') return
	try {
		const { files, manifestContent } = packageSourceFiles(input)
		if (typeof manifestContent !== 'string') return
		const { needs } = await computeCredentialNeedsClosure({
			env: input.env,
			userId: input.source.user_id,
			manifest: parseAuthoredPackageJson({
				content: manifestContent,
				mode: 'published',
			}),
			files,
			visiting: new Set([input.source.id]),
		})
		await writePublishedCredentialNeeds({
			env: input.env,
			sourceId: input.source.id,
			publishedCommit: input.publishedCommit,
			needs,
		})
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'repo.publish.store-credential-needs' },
			extra: {
				sourceId: input.source.id,
				publishedCommit: input.publishedCommit,
			},
		})
	}
}

/**
 * Persist a package's credential stamp next to its published artifact
 * (issue #3836 phase 1). Best effort like credential-needs: a missing stamp
 * is rebuilt on the next publish. A stored stamp is what turns on runtime
 * fail-closed for that package (issue #3836 phase 3).
 */
import { resolveSecretProviderSlots } from './secret-provider-slots.ts'
import * as Sentry from '@sentry/cloudflare'
import {
	getEntitySourceById,
	listEntitySourcesByIds,
} from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import {
	readPublishedCredentialStamp,
	writePublishedCredentialStamp,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	buildCredentialStamp,
	isStoredCredentialStamp,
	mergeCredentialStampIntoManifestFiles,
	omitOversizedCredentialStampModules,
	scanCredentialStamp,
	type CredentialDepStamp,
	type CredentialStamp,
} from './credential-stamp.ts'
import { packageSourceFiles } from './credential-needs-closure.ts'

/**
 * Resolve live dependency stamp pins for a package file map (same pins
 * `storePublishedCredentialStamp` writes). Exported so fleet can tell a
 * current stamp from one that still pins a pre-stamp empty fallback.
 */
export async function resolvePublishedCredentialDepStamps(input: {
	env: Env
	userId: string
	packageName: string
	files: Record<string, string>
}): Promise<Array<CredentialDepStamp>> {
	return loadDependencyStamps(input)
}

async function loadDependencyStamps(input: {
	env: Env
	userId: string
	packageName: string
	files: Record<string, string>
}): Promise<Array<CredentialDepStamp>> {
	// Import collection AST-walks every file; drop oversized prebuilt assets
	// the same way scanCredentialStamp does so fleet pin checks and publish
	// do not DO-reset on multi-MB client bundles.
	const files = omitOversizedCredentialStampModules(input.files)
	const names = [
		...new Set(
			collectStaticKodyPackageImportsFromFiles(files)
				.map((imported) => imported.packageName)
				.filter((name) => name !== input.packageName),
		),
	].sort()
	const resolutions = await Promise.all(
		names.map(async (packageName) => {
			const resolution = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.userId,
				specifier: { packageName, exportName: '.' },
			})
			if (!resolution?.row.sourceId) return null
			return resolution
		}),
	)
	const found = resolutions.filter(
		(resolution): resolution is NonNullable<typeof resolution> =>
			resolution !== null,
	)
	if (found.length === 0) return []
	const sourceIds = found.map((resolution) => resolution.row.sourceId)
	const [singleId] = sourceIds
	const sourceRows =
		sourceIds.length === 1 && singleId
			? await getEntitySourceById(input.env.APP_DB, singleId).then((row) =>
					row ? [row] : [],
				)
			: await listEntitySourcesByIds(input.env.APP_DB, sourceIds)
	const sourcesById = new Map(sourceRows.map((row) => [row.id, row]))
	const deps = await Promise.all(
		found.map(async (resolution) => {
			const source = sourcesById.get(resolution.row.sourceId)
			const publishedCommit = source?.published_commit
			if (!publishedCommit) return null
			const stored = await readPublishedCredentialStamp({
				env: input.env,
				sourceId: resolution.row.sourceId,
				publishedCommit,
			})
			if (!isStoredCredentialStamp(stored)) {
				// Pre-stamp dependency: pin an empty stamp hash so the root
				// still records the published commit. Phase 2 republish fills
				// real hashes; phase 3 refuses drift.
				const empty = await buildCredentialStamp({ keys: [] })
				return {
					packageId: resolution.row.id,
					publishedCommit,
					stampHash: empty.stampHash,
				} satisfies CredentialDepStamp
			}
			return {
				packageId: resolution.row.id,
				publishedCommit,
				stampHash: stored.stampHash,
			} satisfies CredentialDepStamp
		}),
	)
	return deps.filter((dep): dep is CredentialDepStamp => dep != null)
}

/**
 * Build and store the credential stamp for one package publish. Also merges
 * missing stamp keys into the in-memory file map's package.json (caller should
 * pass the same files written to the source snapshot when possible).
 */
export async function storePublishedCredentialStamp(input: {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	files: Record<string, string>
}): Promise<{ stamp: CredentialStamp; files: Record<string, string> } | null> {
	if (input.source.entity_kind !== 'package') return null
	try {
		const { files, manifestContent } = packageSourceFiles(input)
		if (typeof manifestContent !== 'string') return null
		const manifest = parseAuthoredPackageJson({
			content: manifestContent,
			mode: 'published',
		})
		const scanned = scanCredentialStamp(files, {
			secretProviders: await resolveSecretProviderSlots({
				env: input.env,
				userId: input.source.user_id,
				files,
			}),
		})
		const merged = mergeCredentialStampIntoManifestFiles(files, scanned.keys)
		const depStamps = await loadDependencyStamps({
			env: input.env,
			userId: input.source.user_id,
			packageName: manifest.name,
			files: merged.files,
		})
		const stamp = await buildCredentialStamp({
			keys: scanned.keys,
			depStamps,
		})
		await writePublishedCredentialStamp({
			env: input.env,
			sourceId: input.source.id,
			publishedCommit: input.publishedCommit,
			stamp,
		})
		return { stamp, files: merged.files }
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'repo.publish.store-credential-stamp' },
			extra: {
				sourceId: input.source.id,
				publishedCommit: input.publishedCommit,
			},
		})
		return null
	}
}

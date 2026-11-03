import { McpCallerError } from '#mcp/caller-error.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import type { AuthoredPackageJson } from '#worker/package-registry/types.ts'
import {
	loadPublishedSourceManifestSnapshot,
	loadPublishedSourceSnapshot,
	persistPublishedSourceManifestSnapshot,
	persistPublishedSourceSnapshot,
	publishedSourceSnapshotCreatedAt,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactTreeAtCommit } from './artifact-file.ts'
import { readArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import { getEntitySourceById } from './entity-sources.ts'

export type PublishedEntitySource = {
	source: Awaited<ReturnType<typeof getEntitySourceById>>
	files: Record<string, string>
	/** KV snapshot `createdAt` when finalize wrote this commit; null on artifact backfill. */
	snapshotCreatedAt: string | null
}

export type PublishedEntityManifest = {
	source: Awaited<ReturnType<typeof getEntitySourceById>>
	manifest: AuthoredPackageJson
	content: string
}

function freezeFiles(files: Record<string, string>) {
	return Object.freeze({ ...files }) as Record<string, string>
}

function assertPublishedCommit(
	source: NonNullable<PublishedEntitySource['source']>,
) {
	if (!source.published_commit) {
		throw new Error(`Source "${source.id}" has no published commit.`)
	}
	return source.published_commit
}

async function describeMissingPublishedSnapshot(input: {
	env: Env
	source: NonNullable<PublishedEntitySource['source']>
	publishedCommit: string
	cause?: unknown
}) {
	let packageLabel = `source "${input.source.id}"`
	if (input.source.entity_kind === 'package') {
		const saved = await getSavedPackageById(input.env.APP_DB, {
			userId: input.source.user_id,
			packageId: input.source.entity_id,
		}).catch(() => null)
		packageLabel = saved
			? `package "${saved.name}" (${saved.id})`
			: `package "${input.source.entity_id}"`
	}
	// Keep Artifacts remotes/hosts out of the caller-facing message; attach
	// the recovery cause for logs/Sentry without leaking it into Open API.
	return new McpCallerError(
		`Published snapshot for ${packageLabel} at commit "${input.publishedCommit}" is missing and could not be recovered from the artifact repo. Republish the package to restore it.`,
		input.cause !== undefined ? { cause: input.cause } : undefined,
	)
}

/**
 * Load the published file tree when the KV snapshot is missing. Production
 * never enables the mock artifact-API stand-in, so we rebuild from the
 * Artifacts git tip at `published_commit` and let the caller persist KV.
 */
async function loadSourceSnapshotFromArtifacts(input: {
	env: Env
	source: NonNullable<PublishedEntitySource['source']>
}) {
	const publishedCommit = assertPublishedCommit(input.source)
	try {
		const mockSnapshot = await readArtifactSourceSnapshot({
			env: input.env,
			repoId: input.source.repo_id,
			commit: publishedCommit,
		})
		if (mockSnapshot?.files) {
			return mockSnapshot.files
		}
	} catch {
		// Local mock API is optional; fall through to Artifacts git.
	}
	try {
		const files = await readArtifactTreeAtCommit({
			env: input.env,
			repoId: input.source.repo_id,
			commit: publishedCommit,
		})
		if (files && Object.keys(files).length > 0) {
			return files
		}
	} catch (error) {
		throw await describeMissingPublishedSnapshot({
			env: input.env,
			source: input.source,
			publishedCommit,
			cause: error,
		})
	}
	throw await describeMissingPublishedSnapshot({
		env: input.env,
		source: input.source,
		publishedCommit,
	})
}

function parsePublishedManifest(input: {
	source: NonNullable<PublishedEntitySource['source']>
	content: string
}) {
	return parseAuthoredPackageJson({
		content: input.content,
		manifestPath: input.source.manifest_path,
		mode: 'published',
	})
}

async function loadManifestSnapshotFromArtifacts(input: {
	env: Env
	source: NonNullable<PublishedEntitySource['source']>
}) {
	const files = await loadSourceSnapshotFromArtifacts(input)
	const content = files[input.source.manifest_path]
	if (!content) {
		throw new McpCallerError(
			`Published manifest for source "${input.source.id}" at path "${input.source.manifest_path}" was not found. Republish the package to restore it.`,
		)
	}
	return { content, files }
}

export async function loadPublishedEntitySource(input: {
	env: Env
	userId: string
	sourceId: string
	source?: NonNullable<PublishedEntitySource['source']>
}): Promise<PublishedEntitySource> {
	const source =
		input.source ??
		(await getEntitySourceById(input.env.APP_DB, input.sourceId))
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	if (input.source && input.source.id !== input.sourceId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	assertPublishedCommit(source)
	const storedSnapshot = await loadPublishedSourceSnapshot({
		env: input.env,
		userId: input.userId,
		source,
	})
	const files =
		storedSnapshot?.files ??
		(await loadSourceSnapshotFromArtifacts({
			env: input.env,
			source,
		}))
	if (!storedSnapshot) {
		await persistPublishedSourceSnapshot({
			env: input.env,
			userId: input.userId,
			source,
			snapshot: {
				files,
			},
			recoveredFromArtifacts: true,
		})
	}
	return {
		source,
		files: freezeFiles(files),
		snapshotCreatedAt: publishedSourceSnapshotCreatedAt(storedSnapshot),
	}
}

export async function loadPublishedEntityManifest(input: {
	env: Env
	userId: string
	sourceId: string
	source?: NonNullable<PublishedEntityManifest['source']>
}): Promise<PublishedEntityManifest> {
	const source =
		input.source ??
		(await getEntitySourceById(input.env.APP_DB, input.sourceId))
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	if (input.source && input.source.id !== input.sourceId) {
		throw new Error(`Published source "${input.sourceId}" was not found.`)
	}
	assertPublishedCommit(source)
	const storedManifest = await loadPublishedSourceManifestSnapshot({
		env: input.env,
		userId: input.userId,
		source,
	})
	if (storedManifest) {
		return {
			source,
			content: storedManifest.manifestContent,
			manifest: parsePublishedManifest({
				source,
				content: storedManifest.manifestContent,
			}),
		}
	}
	const recovered = await loadManifestSnapshotFromArtifacts({
		env: input.env,
		source,
	})
	await persistPublishedSourceManifestSnapshot({
		env: input.env,
		userId: input.userId,
		source,
		snapshot: {
			manifestContent: recovered.content,
		},
	})
	// Also persist the full tree when recovering from artifacts so the next
	// source load does not pay another git fetch.
	await persistPublishedSourceSnapshot({
		env: input.env,
		userId: input.userId,
		source,
		snapshot: {
			files: recovered.files,
		},
		recoveredFromArtifacts: true,
	}).catch(() => undefined)
	return {
		source,
		content: recovered.content,
		manifest: parsePublishedManifest({
			source,
			content: recovered.content,
		}),
	}
}

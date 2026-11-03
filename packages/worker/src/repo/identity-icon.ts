import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { cachified } from '@epic-web/cachified'
import {
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import {
	createKvCachifiedCache,
	derivedCacheKeyPrefix,
} from '#worker/kv-cachified.ts'
import {
	processCommunityIcon,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import {
	fitIconRaster,
	iconFitCustomMetadata,
	publicFittedIconCacheControl,
} from '#worker/community/icon-fit.ts'
import { identityIconLeafName } from '#universal/identity-icon-leaf.ts'
import { readFirstArtifactFileAtCommit } from './artifact-file.ts'
import {
	identityIconAliasPaths,
	identityIconSourcePaths,
	isIdentityIconSourcePath,
	type IdentityIconSourcePath,
} from './identity-icon-paths.ts'
import { updateEntitySource } from './entity-sources.ts'
import type { EntityKind, EntitySourceRow } from './types.ts'

export const identityIconVersion = 1 as const
const identityIconDescriptorTtlMs = 30 * 24 * 60 * 60 * 1000
export const identityIconCacheControl = publicFittedIconCacheControl

type IdentityIconContentType = 'image/png' | 'image/webp' | 'image/jpeg'

type IdentityIconDescriptor = {
	version: typeof identityIconVersion
	repoId: string
	iconCommit: string
	r2Key: string
	contentType: IdentityIconContentType
	sourcePath: IdentityIconSourcePath | null
	byteLength: number
}

export function buildIdentityIconCacheKey(input: {
	repoId: string
	commit: string
}) {
	return `identity-icon:v${identityIconVersion}:${input.repoId}:${input.commit}`
}

export function buildIdentityIconR2Key(input: {
	repoId: string
	commit: string
}) {
	return `identity-icon:v${identityIconVersion}/${input.repoId}/${input.commit}/asset`
}

export function identityIconKvRepoPrefixes(repoId: string) {
	return [
		`${derivedCacheKeyPrefix}identity-icon:v${identityIconVersion}:${repoId}:`,
	]
}

export function identityIconR2RepoPrefixes(repoId: string) {
	return [`identity-icon:v${identityIconVersion}/${repoId}/`]
}

export function identityIconCommitForKind(input: {
	entityKind: EntityKind
	publishedCommit: string | null
	indexedCommit: string | null
}) {
	if (input.entityKind === 'package') {
		return input.publishedCommit
	}
	return input.indexedCommit ?? input.publishedCommit
}

export function identityIconCommitForSource(source: EntitySourceRow) {
	return identityIconCommitForKind({
		entityKind: source.entity_kind,
		publishedCommit: source.published_commit,
		indexedCommit: source.indexed_commit,
	})
}

export async function getIdentityIconObject(input: {
	env: Env
	repoId: string
	iconCommit: string
	ownerUserId: OwnerId
	leafName: string
	includePackageAppIcon?: boolean
	isServableCommit: () => Promise<boolean>
}): Promise<{
	descriptor: IdentityIconDescriptor
	object: R2ObjectBody
}> {
	const baseCache = createKvCachifiedCache(input.env.BUNDLE_ARTIFACTS_KV)
	const cache = {
		...baseCache,
		async set(key: string, entry: Parameters<typeof baseCache.set>[1]) {
			if (await input.isServableCommit()) {
				const write = async () => await baseCache.set(key, entry)
				if (typeof input.env.APP_DB.prepare === 'function') {
					await withAccountWriteLease({
						db: input.env.APP_DB,
						stableUserId: input.ownerUserId,
						env: input.env,
						write,
					})
				} else {
					await write()
				}
			}
		},
	}
	const key = buildIdentityIconCacheKey({
		repoId: input.repoId,
		commit: input.iconCommit,
	})
	const expectedR2Key = buildIdentityIconR2Key({
		repoId: input.repoId,
		commit: input.iconCommit,
	})
	const loadDescriptor = (forceFresh = false) =>
		cachified({
			key,
			cache,
			ttl: identityIconDescriptorTtlMs,
			forceFresh,
			checkValue: (value) =>
				isIdentityIconDescriptor(value) &&
				value.repoId === input.repoId &&
				value.iconCommit === input.iconCommit &&
				value.r2Key === expectedR2Key,
			getFreshValue: () => createIdentityIconDescriptor(input),
		})

	let descriptor = await loadDescriptor()
	let object = await input.env.COMMUNITY_ASSETS.get(descriptor.r2Key)
	if (!object) {
		await cache.delete(key)
		descriptor = await loadDescriptor(true)
		object = await input.env.COMMUNITY_ASSETS.get(descriptor.r2Key)
	}
	if (!object) {
		throw new Error(
			`Identity icon object "${descriptor.r2Key}" was not available after regeneration.`,
		)
	}
	return { descriptor, object }
}

export async function deleteIdentityIconAssets(input: {
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV' | 'COMMUNITY_ASSETS'>
	repoId: string
	keepCommits?: ReadonlyArray<string>
}) {
	if (
		!input.env.BUNDLE_ARTIFACTS_KV?.list ||
		!input.env.COMMUNITY_ASSETS?.list
	) {
		return
	}
	const keptKvKeys = new Set(
		(input.keepCommits ?? []).map(
			(commit) =>
				derivedCacheKeyPrefix +
				buildIdentityIconCacheKey({ repoId: input.repoId, commit }),
		),
	)
	const keptR2Keys = new Set(
		(input.keepCommits ?? []).map((commit) =>
			buildIdentityIconR2Key({ repoId: input.repoId, commit }),
		),
	)
	for (const prefix of identityIconKvRepoPrefixes(input.repoId)) {
		let kvCursor: string | undefined
		do {
			const page = await input.env.BUNDLE_ARTIFACTS_KV.list({
				prefix,
				cursor: kvCursor,
			})
			await Promise.all(
				page.keys
					.map((key) => key.name)
					.filter((name) => !keptKvKeys.has(name))
					.map((name) => input.env.BUNDLE_ARTIFACTS_KV.delete(name)),
			)
			kvCursor = page.list_complete ? undefined : page.cursor
		} while (kvCursor)
	}
	for (const prefix of identityIconR2RepoPrefixes(input.repoId)) {
		let r2Cursor: string | undefined
		do {
			const page = await input.env.COMMUNITY_ASSETS.list({
				prefix,
				cursor: r2Cursor,
			})
			await Promise.all(
				page.objects
					.map((object) => object.key)
					.filter((objectKey) => !keptR2Keys.has(objectKey))
					.map((objectKey) => input.env.COMMUNITY_ASSETS.delete(objectKey)),
			)
			r2Cursor = page.truncated ? page.cursor : undefined
		} while (r2Cursor)
	}
}

/**
 * Push/publish hook: stamp the indexed commit for live-at-HEAD repos and drop
 * superseded derived marks so the next list request regenerates from the new
 * commit. Failures must not unwind publish.
 */
export async function refreshIdentityIconForSource(input: {
	env: Env
	source: EntitySourceRow
	iconCommit: string
	indexLiveHead?: boolean
}) {
	if (input.indexLiveHead && input.source.entity_kind === 'repo') {
		await updateEntitySource(input.env.APP_DB, {
			id: input.source.id,
			userId: input.source.user_id,
			indexedCommit: input.iconCommit,
		})
	}
	await deleteIdentityIconAssets({
		env: input.env,
		repoId: input.source.repo_id,
		keepCommits: [input.iconCommit],
	})
}

async function createIdentityIconDescriptor(input: {
	env: Env
	repoId: string
	iconCommit: string
	ownerUserId: OwnerId
	leafName: string
	includePackageAppIcon?: boolean
	isServableCommit: () => Promise<boolean>
}): Promise<IdentityIconDescriptor> {
	const write = async () => {
		if (typeof input.env.APP_DB.prepare === 'function') {
			await assertAccountWritableDb(input.env.APP_DB, input.ownerUserId)
		}
		const iconSource = await loadIdentityIconSource(input)
		const processed = iconSource
			? await processCommunityIcon({
					path: iconSource.path,
					sourceBytes: iconSource.bytes,
					images: input.env.IMAGES,
				})
			: await fitIconRaster({
					images: input.env.IMAGES,
					bytes: await renderCommunityIconFallbackPng(
						identityIconLeafName(input.leafName),
					),
				})
		const r2Key = buildIdentityIconR2Key({
			repoId: input.repoId,
			commit: input.iconCommit,
		})
		await input.env.COMMUNITY_ASSETS.put(r2Key, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: identityIconCacheControl,
			},
			customMetadata: iconFitCustomMetadata({
				repoId: input.repoId,
				iconCommit: input.iconCommit,
				sourcePath: iconSource?.path ?? '',
			}),
		})
		if (!(await input.isServableCommit())) {
			await input.env.COMMUNITY_ASSETS.delete(r2Key)
			throw new Error(
				`Identity icon for repo "${input.repoId}" was removed while it was generated.`,
			)
		}
		return {
			version: identityIconVersion,
			repoId: input.repoId,
			iconCommit: input.iconCommit,
			r2Key,
			contentType: processed.contentType,
			sourcePath: iconSource?.path ?? null,
			byteLength: processed.bytes.byteLength,
		}
	}
	return typeof input.env.APP_DB.prepare === 'function'
		? await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: input.ownerUserId,
				env: input.env,
				write,
			})
		: await write()
}

async function loadIdentityIconSource(input: {
	env: Env
	repoId: string
	iconCommit: string
	includePackageAppIcon?: boolean
}): Promise<{ path: IdentityIconSourcePath; bytes: Uint8Array } | null> {
	const found = await readFirstArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.iconCommit,
		filePaths: input.includePackageAppIcon
			? identityIconSourcePaths
			: identityIconAliasPaths,
	})
	if (!found || !isIdentityIconSourcePath(found.path)) return null
	return { path: found.path, bytes: found.bytes }
}

function isIdentityIconDescriptor(
	value: unknown,
): value is IdentityIconDescriptor {
	if (!value || typeof value !== 'object') return false
	const descriptor = value as Partial<IdentityIconDescriptor>
	return (
		descriptor.version === identityIconVersion &&
		typeof descriptor.repoId === 'string' &&
		typeof descriptor.iconCommit === 'string' &&
		typeof descriptor.r2Key === 'string' &&
		['image/png', 'image/webp', 'image/jpeg'].includes(
			descriptor.contentType ?? '',
		) &&
		(descriptor.sourcePath === null ||
			isIdentityIconSourcePath(descriptor.sourcePath ?? '')) &&
		typeof descriptor.byteLength === 'number'
	)
}

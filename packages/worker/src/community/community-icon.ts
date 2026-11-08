import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { cachified } from '@epic-web/cachified'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import {
	createKvCachifiedCache,
	derivedCacheKeyPrefix,
} from '#worker/kv-cachified.ts'
import { readFirstArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import {
	fitIconRaster,
	iconFitCustomMetadata,
	iconFitMaxDimension,
	publicFittedIconCacheControl,
} from './icon-fit.ts'
import {
	findIdentityIconPath,
	identityIconSourcePaths,
	isIdentityIconSourcePath,
	type IdentityIconSourcePath,
} from '#worker/repo/identity-icon-paths.ts'
import { buildCommunityIconFallbackSvg } from './community-icon-fallback.ts'
import {
	getCommunityListingById,
	getCommunityListingByOwnerAndPackage,
} from './repo.ts'
import type { CommunityListingRecord } from './types.ts'

export const communityIconVersion = 3 as const
const communityIconAssetVersions = [1, 2, communityIconVersion] as const
export { buildCommunityIconFallbackSvg } from './community-icon-fallback.ts'
const communityIconOutputSize = iconFitMaxDimension
const maxCommunityIconSourceBytes = 2 * 1024 * 1024
const maxCommunityIconDimension = 4096
const maxCommunityIconPixels = 16_777_216
const maxCommunityIconRenderedBytes = 2 * 1024 * 1024
const communityIconDescriptorTtlMs = 30 * 24 * 60 * 60 * 1000
export const communityIconCacheControl = publicFittedIconCacheControl

export const communityIconPaths = identityIconSourcePaths

type CommunityIconContentType = 'image/png' | 'image/webp' | 'image/jpeg'

type CommunityIconDescriptor = {
	version: typeof communityIconVersion
	listingId: string
	iconCommit: string
	r2Key: string
	contentType: CommunityIconContentType
	sourcePath: IdentityIconSourcePath | null
	byteLength: number
}

type ProcessedCommunityIcon = {
	bytes: Uint8Array
	contentType: CommunityIconContentType
}

export function buildCommunityIconCacheKey(input: {
	listingId: string
	commit: string
}) {
	return `community-icon:v${communityIconVersion}:${input.listingId}:${input.commit}`
}

export function communityIconKvListingPrefixes(listingId: string) {
	return communityIconAssetVersions.map(
		(version) =>
			`${derivedCacheKeyPrefix}community-icon:v${version}:${listingId}:`,
	)
}

export function buildCommunityIconR2Key(input: {
	listingId: string
	commit: string
}) {
	return `community-icon:v${communityIconVersion}/${input.listingId}/${input.commit}/asset`
}

export function communityIconR2ListingPrefixes(listingId: string) {
	return communityIconAssetVersions.map(
		(version) => `community-icon:v${version}/${listingId}/`,
	)
}

export function findCommunityIconPath(
	files: Readonly<Record<string, string>>,
): IdentityIconSourcePath | null {
	return findIdentityIconPath(files, { includePackageAppIcon: true })
}

export async function getCommunityIconObject(input: {
	env: Env
	listing: CommunityListingRecord
	iconCommit: string
}): Promise<{
	descriptor: CommunityIconDescriptor
	object: R2ObjectBody
}> {
	const baseCache = createKvCachifiedCache(input.env.BUNDLE_ARTIFACTS_KV)
	const cache = {
		...baseCache,
		async set(key: string, entry: Parameters<typeof baseCache.set>[1]) {
			if (await isServableIconCommit(input)) {
				const write = async () => await baseCache.set(key, entry)
				if (typeof input.env.APP_DB.prepare === 'function') {
					await withAccountWriteLease({
						db: input.env.APP_DB,
						stableUserId: input.listing.ownerUserId,
						env: input.env,
						write,
					})
				} else {
					await write()
				}
			}
		},
	}
	const key = buildCommunityIconCacheKey({
		listingId: input.listing.id,
		commit: input.iconCommit,
	})
	const expectedR2Key = buildCommunityIconR2Key({
		listingId: input.listing.id,
		commit: input.iconCommit,
	})
	const loadDescriptor = (forceFresh = false) =>
		cachified({
			key,
			cache,
			ttl: communityIconDescriptorTtlMs,
			forceFresh,
			checkValue: (value) =>
				isCommunityIconDescriptor(value) &&
				value.listingId === input.listing.id &&
				value.iconCommit === input.iconCommit &&
				value.r2Key === expectedR2Key,
			getFreshValue: () => createCommunityIconDescriptor(input),
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
			`Community icon object "${descriptor.r2Key}" was not available after regeneration.`,
		)
	}
	return { descriptor, object }
}

/**
 * Deletes cached community icon descriptors (KV) and derived assets (R2) for
 * a listing, keeping only entries for the provided commits. Publish paths
 * pass the commits that remain servable; unpublish/delete paths pass none.
 */
export async function deleteCommunityIconAssets(input: {
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV' | 'COMMUNITY_ASSETS'>
	listingId: string
	keepCommits?: ReadonlyArray<string>
}) {
	const keptKvKeys = new Set(
		(input.keepCommits ?? []).map(
			(commit) =>
				derivedCacheKeyPrefix +
				buildCommunityIconCacheKey({ listingId: input.listingId, commit }),
		),
	)
	const keptR2Keys = new Set(
		(input.keepCommits ?? []).map((commit) =>
			buildCommunityIconR2Key({ listingId: input.listingId, commit }),
		),
	)
	for (const prefix of communityIconKvListingPrefixes(input.listingId)) {
		let kvCursor: string | undefined
		do {
			const page = await input.env.BUNDLE_ARTIFACTS_KV.list({
				prefix,
				cursor: kvCursor,
			})
			const keepCurrentVersion = prefix.includes(
				`community-icon:v${communityIconVersion}:`,
			)
			await Promise.all(
				page.keys
					.map((key) => key.name)
					.filter((name) => !keepCurrentVersion || !keptKvKeys.has(name))
					.map((name) => input.env.BUNDLE_ARTIFACTS_KV.delete(name)),
			)
			kvCursor = page.list_complete ? undefined : page.cursor
		} while (kvCursor)
	}
	for (const prefix of communityIconR2ListingPrefixes(input.listingId)) {
		let r2Cursor: string | undefined
		do {
			const page = await input.env.COMMUNITY_ASSETS.list({
				prefix,
				cursor: r2Cursor,
			})
			const keepCurrentVersion = prefix.includes(
				`community-icon:v${communityIconVersion}/`,
			)
			await Promise.all(
				page.objects
					.map((object) => object.key)
					.filter(
						(objectKey) => !keepCurrentVersion || !keptR2Keys.has(objectKey),
					)
					.map((objectKey) => input.env.COMMUNITY_ASSETS.delete(objectKey)),
			)
			r2Cursor = page.truncated ? page.cursor : undefined
		} while (r2Cursor)
	}
}

/**
 * Package-publish hook: when the owner republishes the package behind an
 * active community listing, drop cached icon assets for superseded commits
 * and bust the public listing data cache so pages emit the new icon URL
 * (which embeds the new published commit) promptly.
 */
export async function refreshCommunityIconForPackagePublish(input: {
	env: Env
	userId: OwnerId
	packageId: string
	publishedCommit: string
}) {
	const listing = await getCommunityListingByOwnerAndPackage(input.env.APP_DB, {
		ownerUserId: input.userId,
		packageId: input.packageId,
	})
	if (!listing || listing.status !== 'active') return
	await deleteCommunityIconAssets({
		env: input.env,
		listingId: listing.id,
		keepCommits: [listing.pinnedCommit, input.publishedCommit],
	})
	invalidateCommunityPublicCache()
}

async function loadCommunityIconSource(input: {
	env: Env
	listing: CommunityListingRecord
	iconCommit: string
}): Promise<{
	path: IdentityIconSourcePath
	bytes: Uint8Array
} | null> {
	// Icons come straight from the owner package's Artifacts repo at the icon
	// commit so raster bytes stay byte-accurate.
	const source = await getValidatedListingPackageSource(input)
	// A listing whose package source row is gone renders the monogram.
	if (!source) return null
	const found = await readFirstArtifactFileAtCommit({
		env: input.env,
		repoId: source.repo_id,
		commit: input.iconCommit,
		filePaths: communityIconPaths,
	})
	if (!found) return null
	if (!isIdentityIconSourcePath(found.path)) return null
	return { path: found.path, bytes: found.bytes }
}

async function getValidatedListingPackageSource(input: {
	env: Env
	listing: CommunityListingRecord
}): Promise<EntitySourceRow | null> {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.listing.sourceId,
	)
	if (!source) return null
	if (
		source.user_id !== input.listing.ownerUserId ||
		source.entity_kind !== 'package' ||
		source.entity_id !== input.listing.packageId
	) {
		throw new Error(
			`Catalog entry "${input.listing.id}" has an invalid package source.`,
		)
	}
	return source
}

async function createCommunityIconDescriptor(input: {
	env: Env
	listing: CommunityListingRecord
	iconCommit: string
}): Promise<CommunityIconDescriptor> {
	const write = async () => {
		const iconSource = await loadCommunityIconSource(input)
		const processed: ProcessedCommunityIcon = iconSource
			? await processCommunityIcon({
					path: iconSource.path,
					sourceBytes: iconSource.bytes,
					images: input.env.IMAGES,
				})
			: await fitIconRaster({
					images: input.env.IMAGES,
					bytes: await renderCommunitySvgIcon(
						buildCommunityIconFallbackSvg(input.listing.name),
					),
				})

		const r2Key = buildCommunityIconR2Key({
			listingId: input.listing.id,
			commit: input.iconCommit,
		})
		await input.env.COMMUNITY_ASSETS.put(r2Key, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: communityIconCacheControl,
			},
			customMetadata: iconFitCustomMetadata({
				listingId: input.listing.id,
				iconCommit: input.iconCommit,
				sourcePath: iconSource?.path ?? '',
			}),
		})
		if (!(await isServableIconCommit(input))) {
			await input.env.COMMUNITY_ASSETS.delete(r2Key)
			throw new Error(
				`Catalog entry "${input.listing.id}" was removed while its icon was generated.`,
			)
		}
		return {
			version: communityIconVersion,
			listingId: input.listing.id,
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
				stableUserId: input.listing.ownerUserId,
				env: input.env,
				write,
			})
		: await write()
}

/**
 * A commit stays cacheable while the listing is still active with the same
 * owner/package/source identity and the commit is either the pinned snapshot
 * commit or the current icon commit. This keeps unpublish/delete cleanup
 * race-free: assets are never re-persisted for removed or superseded state.
 */
async function isServableIconCommit(input: {
	env: Pick<Env, 'APP_DB'>
	listing: CommunityListingRecord
	iconCommit: string
}) {
	if (typeof input.env.APP_DB.prepare === 'function') {
		try {
			await assertAccountWritableDb(input.env.APP_DB, input.listing.ownerUserId)
		} catch (error) {
			if (error instanceof AccountDeletionInProgressError) return false
			throw error
		}
	}
	const current = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listing.id,
		includeDelisted: false,
	})
	return (
		current?.ownerUserId === input.listing.ownerUserId &&
		current.packageId === input.listing.packageId &&
		current.sourceId === input.listing.sourceId &&
		(current.pinnedCommit === input.iconCommit ||
			current.iconCommit === input.iconCommit)
	)
}

export async function processCommunityIcon(input: {
	path: IdentityIconSourcePath
	sourceBytes: Uint8Array
	images: ImagesBinding
}): Promise<ProcessedCommunityIcon> {
	assertCommunityIconSourceSize(input.sourceBytes)
	if (input.path.endsWith('.svg')) {
		const source = decodeSvg(input.sourceBytes)
		assertSafeCommunitySvg(source)
		const bytes = await renderCommunitySvgIcon(source)
		return await fitIconRaster({ images: input.images, bytes })
	}

	const dimensions = readRasterDimensions(input.path, input.sourceBytes)
	assertCommunityIconDimensions(dimensions)
	return await fitIconRaster({
		images: input.images,
		bytes: input.sourceBytes,
	})
}

function assertCommunityIconSourceSize(bytes: Uint8Array) {
	if (
		bytes.byteLength === 0 ||
		bytes.byteLength > maxCommunityIconSourceBytes
	) {
		throw new Error(
			`Community icons must be between 1 byte and ${maxCommunityIconSourceBytes} bytes.`,
		)
	}
}

function decodeSvg(bytes: Uint8Array) {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new Error('Community SVG icons must be valid UTF-8.')
	}
}

function assertSafeCommunitySvg(source: string) {
	if (!/<svg(?:\s|>)/i.test(source)) {
		throw new Error('Community SVG icons must contain an <svg> root element.')
	}
	if (
		/<(?:script|foreignObject|iframe|object|embed)\b/i.test(source) ||
		/<!DOCTYPE|<!ENTITY/i.test(source) ||
		/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|file:|javascript:|data:text\/html)/i.test(
			source,
		) ||
		/url\(\s*["']?(?:https?:|\/\/|file:|javascript:)/i.test(source)
	) {
		throw new Error(
			'Community SVG icons cannot contain active external content.',
		)
	}
}

async function renderCommunitySvgIcon(source: string) {
	// SVG icons are uncommon. Keep Resvg's WASM glue and module-scope setup
	// outside the startup path of every Worker that imports the community
	// capability graph.
	const [{ Resvg }, { ensureResvgWasmReady }] = await Promise.all([
		import('@resvg/resvg-wasm'),
		import('#worker/og/resvg-wasm-init.ts'),
	])
	await ensureResvgWasmReady()
	const resvg = new Resvg(source, {
		fitTo: { mode: 'width', value: communityIconOutputSize },
	})
	const rendered = resvg.render()
	try {
		const width = rendered.width
		const height = rendered.height
		assertCommunityIconDimensions({ width, height })
		const png = rendered.asPng()
		if (png.byteLength > maxCommunityIconRenderedBytes) {
			throw new Error(
				`Rendered community icons must not exceed ${maxCommunityIconRenderedBytes} bytes.`,
			)
		}
		return png
	} finally {
		rendered.free()
		resvg.free()
	}
}

function readRasterDimensions(path: IdentityIconSourcePath, bytes: Uint8Array) {
	if (path.endsWith('.png')) return readPngDimensions(bytes)
	if (path.endsWith('.webp')) return readWebpDimensions(bytes)
	return readJpegDimensions(bytes)
}

export function readPngDimensions(bytes: Uint8Array) {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (
		bytes.byteLength < 24 ||
		!signature.every((byte, index) => bytes[index] === byte) ||
		readAscii(bytes, 12, 4) !== 'IHDR'
	) {
		throw new Error('PNG images must contain a valid PNG header.')
	}
	return {
		width: readUint32BigEndian(bytes, 16),
		height: readUint32BigEndian(bytes, 20),
	}
}

export function readJpegDimensions(bytes: Uint8Array) {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		throw new Error('JPEG images must contain a valid JPEG header.')
	}
	const frameMarkers = new Set([
		0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
		0xcf,
	])
	let offset = 2
	while (offset + 3 < bytes.byteLength) {
		while (bytes[offset] === 0xff) offset++
		const marker = bytes[offset]
		offset++
		if (marker == null || marker === 0xd9 || marker === 0xda) break
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		const segmentLength = readUint16BigEndian(bytes, offset)
		if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break
		if (frameMarkers.has(marker)) {
			if (segmentLength < 7) break
			return {
				height: readUint16BigEndian(bytes, offset + 3),
				width: readUint16BigEndian(bytes, offset + 5),
			}
		}
		offset += segmentLength
	}
	throw new Error('JPEG images must contain valid image dimensions.')
}

export function readWebpDimensions(bytes: Uint8Array) {
	if (
		bytes.byteLength < 30 ||
		readAscii(bytes, 0, 4) !== 'RIFF' ||
		readAscii(bytes, 8, 4) !== 'WEBP'
	) {
		throw new Error('WebP images must contain a valid WebP header.')
	}
	const chunk = readAscii(bytes, 12, 4)
	switch (chunk) {
		case 'VP8X':
			return {
				width: 1 + readUint24LittleEndian(bytes, 24),
				height: 1 + readUint24LittleEndian(bytes, 27),
			}
		case 'VP8L':
			if (bytes[20] !== 0x2f) break
			return {
				width: 1 + (bytes[21] ?? 0) + (((bytes[22] ?? 0) & 0x3f) << 8),
				height:
					1 +
					((bytes[22] ?? 0) >> 6) +
					((bytes[23] ?? 0) << 2) +
					(((bytes[24] ?? 0) & 0x0f) << 10),
			}
		case 'VP8 ':
			if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
				break
			}
			return {
				width: readUint16LittleEndian(bytes, 26) & 0x3fff,
				height: readUint16LittleEndian(bytes, 28) & 0x3fff,
			}
		default: {
			const unreachable: string = chunk
			throw new Error(`WebP images use an unsupported "${unreachable}" chunk.`)
		}
	}
	throw new Error('WebP images must contain valid image dimensions.')
}

function assertCommunityIconDimensions(dimensions: {
	width: number
	height: number
}) {
	if (
		!Number.isInteger(dimensions.width) ||
		!Number.isInteger(dimensions.height) ||
		dimensions.width < 1 ||
		dimensions.height < 1 ||
		dimensions.width > maxCommunityIconDimension ||
		dimensions.height > maxCommunityIconDimension ||
		dimensions.width * dimensions.height > maxCommunityIconPixels
	) {
		throw new Error(
			`Community icons must be at most ${maxCommunityIconDimension}px per side and ${maxCommunityIconPixels} total pixels.`,
		)
	}
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
	return (
		(bytes[offset] ?? 0) |
		((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16)
	)
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
	return (
		(((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)) >>>
		0
	)
}

export async function renderCommunityIconFallbackPng(name: string) {
	return await renderCommunitySvgIcon(buildCommunityIconFallbackSvg(name))
}

function isCommunityIconDescriptor(
	value: unknown,
): value is CommunityIconDescriptor {
	if (!value || typeof value !== 'object') return false
	const descriptor = value as Partial<CommunityIconDescriptor>
	return (
		descriptor.version === communityIconVersion &&
		typeof descriptor.listingId === 'string' &&
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

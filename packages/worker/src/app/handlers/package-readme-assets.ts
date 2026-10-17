import { loadPackagePage } from '#app/package-page.ts'
import { resolveCommunityPackageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import {
	buildPackageReadmeAssetHeaders,
	loadPackageReadmeAssetBytes,
	packageReadmeAssetCacheControl,
	packageReadmeAssetPrivateCacheControl,
	sniffPackageReadmeImageContentType,
} from '#worker/community/package-readme-asset.ts'
import {
	isPackageReadmeImagePath,
	resolvePackageReadmeImagePath,
} from '#universal/package-readme-images.ts'
import { isReservedPackageFilesKodyId } from '#universal/package-files.ts'

function notFound() {
	return new Response('Not found', { status: 404 })
}

function selectedAssetPath(relativePath: string | undefined) {
	return resolvePackageReadmeImagePath(relativePath ?? '', '')
}

async function servePublishedPackageReadmeAsset(input: {
	env: Env
	sourceId: string
	commit: string
	relativePath: string
	cacheControl: string
	listingId?: string | null
}) {
	if (!isPackageReadmeImagePath(input.relativePath)) return notFound()
	const bytes = await loadPackageReadmeAssetBytes({
		env: input.env,
		sourceId: input.sourceId,
		commit: input.commit,
		relativePath: input.relativePath,
		listingId: input.listingId,
	})
	if (!bytes) return notFound()
	const contentType = sniffPackageReadmeImageContentType(
		bytes,
		input.relativePath,
	)
	if (!contentType) return notFound()
	return new Response(Uint8Array.from(bytes), {
		headers: buildPackageReadmeAssetHeaders({
			contentType,
			byteLength: bytes.byteLength,
			etag: `"${input.commit}:${input.relativePath}:${bytes.byteLength}"`,
			cacheControl: input.cacheControl,
		}),
	})
}

export function createCommunityPackageAssetHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: {
			username: string
			kodyId: string
			relativePath: string | undefined
		}
	}) => {
		if (isReservedPackageFilesKodyId(params.kodyId)) return notFound()
		const relativePath = selectedAssetPath(params.relativePath)
		if (!relativePath) return notFound()

		const publicTarget = await resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: params.username,
			kodyId: params.kodyId,
		})
		if (publicTarget) {
			const listing = await getCommunityListingById(env.APP_DB, {
				listingId: publicTarget.listingId,
				includeDelisted: false,
			})
			if (!listing) return notFound()
			return servePublishedPackageReadmeAsset({
				env,
				sourceId: listing.sourceId,
				commit: listing.pinnedCommit,
				relativePath,
				listingId: listing.id,
				cacheControl: packageReadmeAssetCacheControl,
			})
		}

		const page = await loadPackagePage({
			env,
			request,
			username: params.username,
			kodyId: params.kodyId,
		})
		if (page.kind !== 'page' || !page.ownerPackage || !page.viewerIsOwner) {
			return notFound()
		}
		return servePublishedPackageReadmeAsset({
			env,
			sourceId: page.ownerPackage.sourceId,
			commit: page.ownerPackage.publishedCommit ?? '',
			relativePath,
			cacheControl: packageReadmeAssetPrivateCacheControl,
		})
	}
}

export function createCommunityDetailAssetHandler(env: Env) {
	return async ({
		params,
	}: {
		params: { listingId: string; relativePath: string | undefined }
	}) => {
		const relativePath = selectedAssetPath(params.relativePath)
		if (!relativePath) return notFound()

		const listing = await getCommunityListingById(env.APP_DB, {
			listingId: params.listingId,
			includeDelisted: false,
		})
		if (!listing) return notFound()

		return servePublishedPackageReadmeAsset({
			env,
			sourceId: listing.sourceId,
			commit: listing.pinnedCommit,
			relativePath,
			listingId: listing.id,
			cacheControl: packageReadmeAssetCacheControl,
		})
	}
}

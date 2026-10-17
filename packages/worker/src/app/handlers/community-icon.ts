import {
	buildCommunityIconFallbackSvg,
	communityIconCacheControl,
	getCommunityIconObject,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'

export function createCommunityIconHandler(env: Env) {
	return async ({
		params,
	}: {
		params: { iconCommit: string; listingId: string }
	}) => {
		const listing = await getCommunityListingById(env.APP_DB, {
			listingId: params.listingId,
			includeDelisted: false,
		})
		// The pinned snapshot commit stays servable alongside the current
		// icon commit so pages cached just before a package publish do not
		// break; anything else is a stale URL and is rejected.
		if (
			!listing ||
			(params.iconCommit !== listing.iconCommit &&
				params.iconCommit !== listing.pinnedCommit)
		) {
			return new Response('Not found', { status: 404 })
		}

		try {
			const { descriptor, object } = await getCommunityIconObject({
				env,
				listing,
				iconCommit: params.iconCommit,
			})
			return new Response(object.body, {
				headers: {
					'Cache-Control': communityIconCacheControl,
					'Content-Length': String(descriptor.byteLength),
					'Content-Type': descriptor.contentType,
					ETag: object.httpEtag,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		} catch (error) {
			console.error('community-icon-load-failed', listing.id, error)
			try {
				const fallback = await renderCommunityIconFallbackPng(listing.name)
				return new Response(new Uint8Array(fallback).buffer, {
					headers: {
						'Cache-Control': 'no-store',
						'Content-Length': String(fallback.byteLength),
						'Content-Type': 'image/png',
						'X-Content-Type-Options': 'nosniff',
					},
				})
			} catch (fallbackError) {
				console.error(
					'community-icon-fallback-render-failed',
					listing.id,
					fallbackError,
				)
			}
			return new Response(buildCommunityIconFallbackSvg(listing.name), {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Security-Policy': "default-src 'none'; sandbox",
					'Content-Type': 'image/svg+xml; charset=utf-8',
					'X-Content-Type-Options': 'nosniff',
				},
			})
		}
	}
}

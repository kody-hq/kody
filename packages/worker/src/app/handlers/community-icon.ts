import {
	buildCommunityIconFallbackSvg,
	communityIconCacheControl,
	communityIconVersion,
	getCommunityIconObject,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { deferWork } from '#worker/deferred-work.ts'
import {
	anonymousHtmlEdgeCacheHeader,
	workerDefaultCache,
} from '#app/anonymous-html-edge-cache.ts'

type CommunityIconParams = { iconCommit: string; listingId: string }

type CommunityIconCacheEnv = Parameters<typeof getCanonicalAppBaseUrl>[0]['env']

/** Headers a stored icon keeps; everything else (cookies, auth echoes) is dropped. */
const sharedIconHeaders = [
	'Cache-Control',
	'Content-Length',
	'Content-Type',
	'ETag',
	'X-Content-Type-Options',
] as const

/**
 * Icon URLs are commit-addressed, so the edge copy is keyed on listing +
 * commit + icon pipeline version only. Query strings, cookies, and auth never
 * reach the key: the bytes are the same for every viewer.
 */
export function buildCommunityIconCacheRequest(
	request: Request,
	env: CommunityIconCacheEnv,
	params: CommunityIconParams,
) {
	const origin = getCanonicalAppBaseUrl({ env, requestUrl: request.url })
	const path = `/community/${encodeURIComponent(params.listingId)}/icon/${encodeURIComponent(params.iconCommit)}`
	return new Request(`${origin}${path}?__icon=v${communityIconVersion}`, {
		method: 'GET',
	})
}

export function isCommunityIconCacheStoreable(response: Response) {
	return (
		response.status === 200 &&
		response.headers.get('Cache-Control') === communityIconCacheControl &&
		!response.headers.has('Set-Cookie')
	)
}

function buildSharedIconEntry(response: Response) {
	const headers = new Headers()
	for (const name of sharedIconHeaders) {
		const value = response.headers.get(name)
		if (value !== null) headers.set(name, value)
	}
	return new Response(response.body, { status: 200, headers })
}

function withIconCacheLookup(response: Response, lookup: 'HIT' | 'MISS') {
	const headers = new Headers(response.headers)
	headers.set(anonymousHtmlEdgeCacheHeader, lookup)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Same `caches.default` store as anonymous HTML. Only the immutable 200 is
 * shared; 404s, `no-store` fallbacks, and errors re-run on every request.
 */
export async function serveCommunityIconFromCache(input: {
	request: Request
	env: CommunityIconCacheEnv
	ctx: Pick<ExecutionContext, 'waitUntil'>
	params: CommunityIconParams
	next: () => Promise<Response>
}): Promise<Response> {
	const { request } = input
	const cache =
		input.env.WRANGLER_IS_LOCAL_DEV === 'true' ||
		(request.method !== 'GET' && request.method !== 'HEAD')
			? null
			: workerDefaultCache()
	if (!cache) return input.next()

	const cacheKey = buildCommunityIconCacheRequest(
		request,
		input.env,
		input.params,
	)
	const cached = await cache.match(cacheKey).catch(() => undefined)
	if (cached) return withIconCacheLookup(cached, 'HIT')

	const response = await input.next()
	if (request.method === 'GET' && isCommunityIconCacheStoreable(response)) {
		const entry = buildSharedIconEntry(response.clone())
		input.ctx.waitUntil(
			cache.put(cacheKey, entry).catch((error: unknown) => {
				console.debug('community-icon-cache-put-failed', error)
			}),
		)
	}
	return withIconCacheLookup(response, 'MISS')
}

export function createCommunityIconHandler(env: Env) {
	const loadIcon = createCommunityIconLoader(env)
	return ({
		request,
		params,
	}: {
		request: Request
		params: CommunityIconParams
	}) =>
		serveCommunityIconFromCache({
			request,
			env,
			ctx: {
				waitUntil: (promise) => {
					void deferWork('community-icon-cache-write-failed', () => promise)
				},
			},
			params,
			next: () => loadIcon(params),
		})
}

function createCommunityIconLoader(env: Env) {
	return async (params: CommunityIconParams) => {
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

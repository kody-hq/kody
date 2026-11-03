import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildCommunityIconFallbackSvg,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import {
	getIdentityIconObject,
	identityIconCacheControl,
} from '#worker/repo/identity-icon.ts'
import { identityIconLeafName } from '#universal/identity-icon-leaf.ts'

export const ownerIdentityIconCacheControl =
	'private, max-age=31536000, immutable'

export async function serveIdentityIcon(input: {
	env: Env
	repoId: string
	iconCommit: string
	ownerUserId: OwnerId
	leafName: string
	includePackageAppIcon?: boolean
	cacheControl?: string
	isServableCommit: () => Promise<boolean>
	logLabel: string
}) {
	try {
		const { descriptor, object } = await getIdentityIconObject({
			env: input.env,
			repoId: input.repoId,
			iconCommit: input.iconCommit,
			ownerUserId: input.ownerUserId,
			leafName: input.leafName,
			includePackageAppIcon: input.includePackageAppIcon,
			isServableCommit: input.isServableCommit,
		})
		return new Response(object.body, {
			headers: {
				'Cache-Control': input.cacheControl ?? identityIconCacheControl,
				'Content-Length': String(descriptor.byteLength),
				'Content-Type': descriptor.contentType,
				ETag: object.httpEtag,
				'X-Content-Type-Options': 'nosniff',
			},
		})
	} catch (error) {
		console.error(`${input.logLabel}-load-failed`, input.repoId, error)
		try {
			const fallback = await renderCommunityIconFallbackPng(
				identityIconLeafName(input.leafName),
			)
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
				`${input.logLabel}-fallback-render-failed`,
				input.repoId,
				fallbackError,
			)
		}
		return new Response(buildCommunityIconFallbackSvg(input.leafName), {
			headers: {
				'Cache-Control': 'no-store',
				'Content-Security-Policy': "default-src 'none'; sandbox",
				'Content-Type': 'image/svg+xml; charset=utf-8',
				'X-Content-Type-Options': 'nosniff',
			},
		})
	}
}

export function identityIconNotFound() {
	return new Response('Not found', { status: 404 })
}

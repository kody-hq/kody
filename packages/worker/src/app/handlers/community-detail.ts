import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { toPublicCommunityListing } from '#app/community-public.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '../operation-result.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	getCommunityIconObject,
	renderCommunityIconFallbackPng,
} from '#worker/community/community-icon.ts'
import { convertIconRasterToPng } from '#worker/community/icon-fit.ts'
import {
	getCommunityListingWithAggregates,
	reportCommunityListing,
} from '#worker/community/service.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

const reportReasonSchema = z
	.string()
	.trim()
	.min(1, 'Report reason is required.')
	.max(2000, 'Report reason must be at most 2000 characters.')

export {
	highlightReadmeFences,
	readmeForPackagePage,
} from '#app/community-package-payload.ts'

/**
 * Resolve a satori-safe data URI for the package community icon. PNG and JPEG
 * bytes embed directly; WebP is converted to PNG through Images because satori
 * cannot decode it. Load failures fall back to the generated mark.
 */
async function loadCommunityOgIconDataUri(input: {
	env: Env
	listing: CommunityListingRecord
}): Promise<string> {
	try {
		const { descriptor, object } = await getCommunityIconObject({
			env: input.env,
			listing: input.listing,
			iconCommit: input.listing.iconCommit,
		})
		const bytes = new Uint8Array(await object.arrayBuffer())
		if (
			descriptor.contentType === 'image/png' ||
			descriptor.contentType === 'image/jpeg'
		) {
			return `data:${descriptor.contentType};base64,${bytesToBase64(bytes)}`
		}
		if (descriptor.contentType === 'image/webp') {
			const png = await convertIconRasterToPng({
				images: input.env.IMAGES,
				bytes,
			})
			return `data:image/png;base64,${bytesToBase64(png)}`
		}
	} catch (error) {
		console.error('community-og-icon-load-failed', input.listing.id, error)
	}

	const fallback = await renderCommunityIconFallbackPng(input.listing.name)
	return `data:image/png;base64,${bytesToBase64(fallback)}`
}

export function createCommunityDetailOgImageHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { listingId: string }
	}) => {
		const listingId = params.listingId
		const listing = await getCommunityListingWithAggregates({
			env,
			listingId,
			includeDelisted: false,
		})
		if (!listing) {
			return new Response('Not found', { status: 404 })
		}

		const publicListing = toPublicCommunityListing(listing)
		const iconDataUri = await loadCommunityOgIconDataUri({ env, listing })
		// `?theme=light` renders the pale variant; anything unrecognised
		// falls back to the default rather than erroring.
		const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

		// Lazy import (sanctioned exception to the no-inline-imports rule):
		// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
		// binaries, which would otherwise bloat isolate cold starts for a
		// route that is only hit by social-media crawlers.
		const { renderCommunityOgImage } =
			await import('#worker/community/og-image.ts')
		const png = await renderCommunityOgImage({
			name: publicListing.name,
			description: publicListing.description,
			ownerUsername: publicListing.ownerUsername,
			averageStars: publicListing.averageStars,
			ratingCount: publicListing.ratingCount,
			forkCount: publicListing.forkCount,
			iconDataUri,
			theme,
			assets: env.ASSETS,
		})

		return new Response(png, {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=3600',
				'Content-Type': 'image/png',
			},
		})
	}
}

export async function reportWebsiteCommunityPackage(input: {
	env: Env
	user: AuthenticatedAppUser
	listingId: string
	body: unknown
}) {
	const { env, user, listingId } = input

	const body = input.body
	if (!body || typeof body !== 'object') {
		return operationResult({ ok: false, error: 'Invalid request body.' }, 400)
	}

	const parsedReason = reportReasonSchema.safeParse(
		(body as Record<string, unknown>).reason,
	)
	if (!parsedReason.success) {
		return operationResult(
			{
				ok: false,
				error:
					parsedReason.error.issues[0]?.message ?? 'Invalid report reason.',
			},
			400,
		)
	}

	try {
		await reportCommunityListing({
			env,
			// Reports identify the acting person, not their personal org.
			userId: personalOrgId(user.mcpUser.userId),
			listingId: listingId,
			reason: parsedReason.data,
		})
		return operationResult({ ok: true })
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		console.error('Community report submission failed:', error)
		return operationResult(
			{ ok: false, error: 'Unable to submit report.' },
			500,
		)
	}
}

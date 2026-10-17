import { z } from 'zod'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { setCommunityListingFeatured } from '#worker/community/service.ts'
import { operationResult } from '../operation-result.ts'

const communityFeaturePostSchema = z.object({
	featured: z.boolean(),
})

export async function featureWebsiteCommunityPackage(input: {
	env: Env
	request: Request
	listingId: string
	body: unknown
}) {
	const { env, request, listingId } = input

	let actor
	try {
		actor = await requireUserWithRole(request, env, 'admin')
	} catch (error) {
		if (error instanceof Response)
			return operationResult({ ok: false, error: 'Forbidden.' }, error.status)
		throw error
	}

	const body = input.body
	const parsed = communityFeaturePostSchema.safeParse(body)
	if (!parsed.success) {
		return operationResult({ ok: false, error: 'Invalid request body.' }, 400)
	}

	try {
		const listing = await setCommunityListingFeatured({
			env,
			listingId: listingId,
			featured: parsed.data.featured,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'admin',
			action: 'community_listing_feature',
			result: 'success',
			email: actor.email,
			ip: getRequestIp(request) ?? undefined,
			path: new URL(request.url).pathname,
			reason: `listing_id=${listing.id};featured=${parsed.data.featured}`,
		})
		return operationResult({ ok: true, featured: listing.featured })
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		console.error('Community feature update failed:', error)
		return operationResult(
			{ ok: false, error: 'Unable to update featuring for this listing.' },
			500,
		)
	}
}

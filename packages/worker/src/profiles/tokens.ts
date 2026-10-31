import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { isProfilesEnabledFor } from './flag.ts'
import { chainExpiry, profileStatus, type ProfileRow } from './rules.ts'
import { loadProfileChain } from './store.ts'

export class ProfileTokenError extends Error {
	readonly status: 403 | 404 | 409
	constructor(status: 403 | 404 | 409, message: string) {
		super(message)
		this.name = 'ProfileTokenError'
		this.status = status
	}
}

/**
 * Decision B3: a person may mint a token for any of their own active
 * profiles; a profile-bound credential may mint for itself or a strict
 * descendant only. The token never outlives the earliest expiry in the
 * target's chain.
 */
export async function resolveProfileTokenTarget(input: {
	db: D1Database
	request: RequestContext
	profileId: string
	now?: string
}): Promise<{ chain: Array<ProfileRow>; maxExpiresAt: string | null }> {
	const actorId = input.request.actor?.userId
	if (!actorId) {
		throw new ProfileTokenError(403, 'Profile tokens need a signed-in person.')
	}
	const orgId = input.request.org.id
	if (!(await isProfilesEnabledFor(input.db, actorId, orgId))) {
		throw new ProfileTokenError(
			404,
			'Profiles are not enabled for this account. Turn on the Profiles experiment first.',
		)
	}
	const chain = await loadProfileChain(input.db, {
		orgId,
		profileId: input.profileId,
	})
	const target = chain.at(-1)
	if (
		!target ||
		target.id !== input.profileId ||
		chain.some((row) => row.acting_user_id !== actorId)
	) {
		throw new ProfileTokenError(
			404,
			'No profile of yours with that id in this org.',
		)
	}
	const callerProfileId = input.request.credential.profileId ?? null
	if (callerProfileId && !chain.some((row) => row.id === callerProfileId)) {
		throw new ProfileTokenError(
			403,
			'A profile can only mint tokens for itself or its sub-profiles.',
		)
	}
	const now = input.now ?? new Date().toISOString()
	const status = profileStatus(chain, now)
	if (status !== 'active') {
		throw new ProfileTokenError(
			409,
			status === 'parent_inactive'
				? `A profile above "${target.name}" is revoked or expired, so it cannot get tokens.`
				: `Profile "${target.name}" is ${status}, so it cannot get tokens.`,
		)
	}
	return { chain, maxExpiresAt: chainExpiry(chain) }
}

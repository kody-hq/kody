/**
 * soft-delete-read-filter: opt-out
 *
 * Availability and suggestion checks must see soft-deleted username/org-slug
 * claims the same way signup does.
 */
import { suggestHandle } from '@kody-internal/shared/handle-rules.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import { isUsernameReleasableForEmail } from '#worker/identity/deleted-account-identity-release.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
	usernameFromEmail,
	usernameTakenError,
} from '#worker/identity/username.ts'

export type UsernameAvailabilityStatus =
	| 'available'
	| 'taken'
	| 'reserved'
	| 'invalid'

export type UsernameAvailabilityResult = {
	username: string
	status: UsernameAvailabilityStatus
	reason: string | null
	suggestions: Array<string>
}

export type UsernameSuggestionSeeds = {
	email?: string | null
	providerUsername?: string | null
	displayName?: string | null
	/** Extra free-form seeds (typed value variations already covered). */
	extra?: Array<string | null | undefined>
}

function pushUnique(
	out: Array<string>,
	seen: Set<string>,
	candidate: string | null | undefined,
) {
	const normalized = candidate ? normalizeUsername(candidate) : ''
	if (!normalized || seen.has(normalized)) return
	seen.add(normalized)
	out.push(normalized)
}

/**
 * Derive candidate handles from identity seeds and the typed value. Does not
 * check availability — callers verify each candidate.
 */
export function collectUsernameSuggestionCandidates(
	typed: string,
	seeds: UsernameSuggestionSeeds = {},
): Array<string> {
	const seen = new Set<string>()
	const out: Array<string> = []
	const typedNormalized = normalizeUsername(typed)
	const typedSuggestion = suggestHandle(typed)

	pushUnique(out, seen, typedSuggestion)
	pushUnique(out, seen, seeds.providerUsername)
	pushUnique(
		out,
		seen,
		seeds.displayName ? suggestHandle(seeds.displayName) : null,
	)
	pushUnique(out, seen, seeds.email ? usernameFromEmail(seeds.email) : null)
	for (const extra of seeds.extra ?? []) {
		pushUnique(out, seen, extra ? suggestHandle(extra) : null)
	}

	const bases = [
		typedNormalized,
		typedSuggestion,
		seeds.providerUsername ? normalizeUsername(seeds.providerUsername) : null,
		seeds.displayName ? suggestHandle(seeds.displayName) : null,
		seeds.email ? usernameFromEmail(seeds.email) : null,
	].filter((value): value is string => Boolean(value))

	for (const base of bases) {
		const prefix = base.slice(0, 27).replace(/-+$/g, '') || 'n'
		for (const suffix of [2, 3, 4, 7, 11]) {
			pushUnique(out, seen, `${prefix}-${suffix}`)
		}
		if (!base.includes('-') && base.length >= 3) {
			pushUnique(out, seen, `${base}-dev`)
			pushUnique(out, seen, `${base}-hq`)
		}
	}

	return out
}

async function isClaimableUsername(
	db: D1Database,
	username: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	if (await getEffectiveUsernameValidationError(username, env)) return false
	if (await isUsernameClaimedInIdentity(db, username)) return false
	return true
}

/**
 * Validate a username with the same rules signup uses, and when it is taken
 * or reserved return a few clickable alternatives that are already verified
 * available.
 */
export async function checkUsernameAvailability(input: {
	db: D1Database
	username: string
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
	seeds?: UsernameSuggestionSeeds
	suggestionLimit?: number
	/** Signup email: its own soft-deleted account's handle counts as free. */
	reclaimEmail?: string | null
}): Promise<UsernameAvailabilityResult> {
	const username = normalizeUsername(input.username)
	const suggestionLimit = input.suggestionLimit ?? 3

	async function suggestionsExcluding(exclude: string) {
		const maxCandidatesChecked = 12
		const candidates = collectUsernameSuggestionCandidates(
			exclude || input.username,
			input.seeds,
		).slice(0, maxCandidatesChecked)
		const available: Array<string> = []
		for (const candidate of candidates) {
			if (candidate === exclude) continue
			if (!(await isClaimableUsername(input.db, candidate, input.env))) {
				continue
			}
			available.push(candidate)
			if (available.length >= suggestionLimit) break
		}
		return available
	}

	if (!username) {
		return {
			username: '',
			status: 'invalid',
			reason: 'Username is required.',
			suggestions: await suggestionsExcluding(''),
		}
	}

	const validationError = await getEffectiveUsernameValidationError(
		username,
		input.env,
	)
	if (validationError) {
		const reserved = /reserved/i.test(validationError)
		return {
			username,
			status: reserved ? 'reserved' : 'invalid',
			reason: validationError,
			suggestions: await suggestionsExcluding(username),
		}
	}

	if (
		(await isUsernameClaimedInIdentity(input.db, username)) &&
		!(
			input.reclaimEmail &&
			(await isUsernameReleasableForEmail(
				input.db,
				username,
				input.reclaimEmail,
			))
		)
	) {
		return {
			username,
			status: 'taken',
			reason: usernameTakenError(username),
			suggestions: await suggestionsExcluding(username),
		}
	}

	return {
		username,
		status: 'available',
		reason: null,
		suggestions: [],
	}
}

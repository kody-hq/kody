export {
	orgSlugPermanentError,
	usernamePermanentError,
} from '@kody-internal/shared/handle-permanence.ts'
import {
	handleFormatRequirements,
	handleMaxLength,
	isCanonicalHandle,
	normalizeHandle,
} from '@kody-internal/shared/handle-rules.ts'
import { getEffectiveReservedUsernameError } from '#worker/identity/reserved-username-settings.ts'
import { getReservedUsernameError } from '#worker/identity/reserved-usernames.ts'

export const usernameRequirements = handleFormatRequirements

export function normalizeUsername(value: unknown) {
	return normalizeHandle(value)
}

export function usernameTakenError(username: string) {
	return `\`${username}\` is taken.`
}

export function usernameReservedClaimError(username: string) {
	return `\`${username}\` is reserved.`
}

export function usernameNotPersistedError(username: string) {
	return `Username was not changed to \`${username}\`.`
}

/**
 * Every username is a valid DNS label (shared {@link isCanonicalHandle}): each
 * user owns a `{username}.` subdomain on the package-app domain. Callers must
 * pass an already-normalized value — uppercase is rejected so lookup paths
 * cannot skip canonicalize. There is no lenient legacy shape — the
 * underscore-era usernames were migrated out of production on 2026-08-12
 * (decision 0017).
 * Remove when: every secret credential row has a stored placement (null placements backfilled).
 */
export function getUsernameFormatValidationError(username: string) {
	if (!username) {
		return 'Username is required.'
	}
	if (!isCanonicalHandle(username)) {
		return usernameRequirements
	}
	return null
}

/**
 * Derive a valid default username from an email local part, satisfying the
 * username format rules (3-32 chars, alphanumeric edges).
 */
export function usernameFromEmail(email: string) {
	const localPart = email.split('@')[0] ?? 'user'
	const normalized = localPart
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	const truncated = normalized
		.slice(0, handleMaxLength)
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	return truncated.length >= 3 ? truncated : `user-${truncated || 'new'}`
}

/** Human-facing fallback display name for accounts without a username. */
export function displayNameFromEmail(email: string) {
	return email.split('@')[0] || 'user'
}

/** Display name for an account: its username, or an email fallback when unusable. */
export function resolveDisplayName(input: { email: string; username: string }) {
	return getUsernameFormatValidationError(input.username)
		? displayNameFromEmail(input.email)
		: input.username
}

/**
 * Prefer a stored `users.display_name` when non-empty after trim; otherwise the
 * fallback (username for OAuth grants, or {@link resolveDisplayName} for web
 * sessions).
 */
export function resolveStoredDisplayName(
	storedDisplayName: string | null | undefined,
	fallback: string,
) {
	return storedDisplayName?.trim() || fallback
}

/**
 * Reserved names are checked before format so a reserved handle shorter than
 * the username minimum (`me`) still gets the reserved-name message.
 */
export function getUsernameValidationError(username: string) {
	return (
		getReservedUsernameError(username) ??
		getUsernameFormatValidationError(username)
	)
}

export async function getEffectiveUsernameValidationError(
	username: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	return (
		(await getEffectiveReservedUsernameError(username, env)) ??
		getUsernameFormatValidationError(username)
	)
}

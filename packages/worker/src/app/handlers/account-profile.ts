import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type ProfileVisibility } from '#universal/loader-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { updateCommunityProfile } from '#worker/community/profile-service.ts'
import {
	normalizeUsername,
	usernamePermanentError,
} from '#worker/identity/username.ts'

function readOptionalString(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	if (!(key in body)) return undefined
	const value = body[key]
	if (value === null) return ''
	if (typeof value !== 'string') return undefined
	return value
}

function readProfileVisibility(
	body: Record<string, unknown>,
): ProfileVisibility | undefined | 'invalid' {
	if (!('profileVisibility' in body)) return undefined
	const value = body.profileVisibility
	if (value === 'public' || value === 'private') return value
	return 'invalid'
}

export async function saveAccountProfile({
	env,
	request,
	user,
	body,
}: {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: Record<string, unknown>
}) {
	const record = body
	const hasUsername = 'username' in record
	const displayName = readOptionalString(record, 'displayName')
	const bio = readOptionalString(record, 'bio')
	const profileVisibility = readProfileVisibility(record)
	const hasProfileFields =
		displayName !== undefined ||
		bio !== undefined ||
		profileVisibility !== undefined

	if (!hasUsername && !hasProfileFields) {
		throw new Error('Invalid request body.')
	}

	if (profileVisibility === 'invalid') {
		throw new Error('Profile visibility is invalid.')
	}

	const requestIp = getRequestIp(request) ?? undefined

	// An unchanged username is a no-op so accounts with grandfathered (e.g.
	// reserved) usernames can still save display name, bio, and visibility
	// from the combined form. Any other username is a rename, and usernames
	// are permanent.
	if (hasUsername && normalizeUsername(record.username) !== user.username) {
		throw new Error(usernamePermanentError)
	}

	if (hasProfileFields) {
		try {
			await updateCommunityProfile({
				env,
				numericUserId: user.userId,
				...(displayName !== undefined ? { displayName } : {}),
				...(bio !== undefined ? { bio } : {}),
				...(profileVisibility !== undefined
					? { visibility: profileVisibility }
					: {}),
			})
		} catch (error) {
			if (error instanceof CommunityActionError) {
				throw error
			}
			throw error
		}

		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'update_profile',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: new URL(request.url).pathname,
		})
	}

	return { ok: true as const }
}

import { buildUserAvatarUrl } from '#app/community-public.ts'
import type {
	AccountProfileLoaderData,
	ProfileVisibility,
} from '#universal/loader-data.ts'
import type { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { listFormerEmailClaims } from '#worker/identity/email-claims.ts'
import { createDb, usersTable } from '#worker/db.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function asProfileVisibility(
	value: string | null | undefined,
): ProfileVisibility {
	return value === 'private' ? 'private' : 'public'
}

export function buildAccountProfilePayload(
	user: AuthenticatedUser,
	profileFields?: {
		username?: string | null
		displayName?: string | null
		bio?: string | null
		avatarKey?: string | null
		profileVisibility?: ProfileVisibility
		formerEmails?: AccountProfileLoaderData['formerEmails']
	},
): AccountProfileLoaderData {
	const rawDisplayName = profileFields?.displayName
	const username = profileFields?.username?.trim() || user.username
	const hasLoadedProfileFields = profileFields !== undefined
	return {
		ok: true,
		email: user.email,
		emailVerified: user.emailVerified,
		emailVerificationDelivery: user.emailVerificationDelivery ?? null,
		username,
		// Prefer an explicit community display name. When profile fields were
		// loaded from the DB and display_name is empty/null (including right
		// after the user cleared it), use the username — not the request's
		// cached auth displayName, which still reflects the pre-update value.
		// When no profile row was loaded, keep the auth display name fallback.
		displayName:
			rawDisplayName != null && rawDisplayName.trim().length > 0
				? rawDisplayName.trim()
				: hasLoadedProfileFields
					? username
					: user.displayName || username,
		bio: profileFields?.bio ?? null,
		avatarUrl: buildUserAvatarUrl({
			username,
			avatarKey: profileFields?.avatarKey ?? null,
		}),
		profileVisibility: profileFields?.profileVisibility ?? 'public',
		formerEmails: profileFields?.formerEmails ?? [],
	}
}

/**
 * Load account profile settings. When `env` is provided, reads community
 * profile fields from the users row so the settings form shows persisted
 * display name / bio / visibility / avatar.
 */
export async function loadAccountProfileData(
	user: AuthenticatedUser,
	env?: Env,
): Promise<AccountProfileLoaderData> {
	if (!env) {
		return buildAccountProfilePayload(user)
	}

	const db = createDb(env.APP_DB)
	const row = await db.findOne(usersTable, { where: { id: user.userId } })
	if (!row) {
		return buildAccountProfilePayload(user)
	}

	return buildAccountProfilePayload(user, {
		username: row.username,
		displayName: row.display_name,
		bio: row.bio,
		avatarKey: row.avatar_key,
		profileVisibility: asProfileVisibility(row.profile_visibility),
		formerEmails: await listFormerEmailClaims(env.APP_DB, {
			userId: user.userId,
			currentEmail: user.email,
		}),
	})
}

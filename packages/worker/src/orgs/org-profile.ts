import {
	normalizeUsername,
	orgSlugPermanentError,
} from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { runAppDbBatchWithOrgAudit, type OrgAuditWriter } from './org-audit.ts'
import {
	loadOrgProfileVisibility,
	type OrgProfileVisibility,
} from './org-public-profile.ts'
import { getOrgById } from './repo.ts'

export type UpdateOrgProfileInput = {
	orgId: string
	displayName?: string
	slug?: string
	profileVisibility?: OrgProfileVisibility
	/** Required to change `profileVisibility`; name-only edits are not audited. */
	audit?: OrgAuditWriter
}

export type UpdateOrgProfileResult =
	| {
			ok: true
			slug: string
			displayName: string | null
			profileVisibility: OrgProfileVisibility
	  }
	| {
			ok: false
			error: string
			code: 'not_found' | 'personal' | 'validation' | 'conflict'
	  }

/**
 * Update a team organization's display name and page visibility (audited as
 * `org.profile_visibility_changed`). Handles (slugs) are permanent:
 * a request that names a different slug is rejected. Signup (personal) orgs keep
 * the person's profile as their name, photo, and handle — edit those on
 * Account instead.
 */
export async function updateOrgProfile(
	db: D1Database,
	input: UpdateOrgProfileInput,
): Promise<UpdateOrgProfileResult> {
	const existing = await getOrgById(db, input.orgId)
	if (!existing) {
		return {
			ok: false,
			error: 'Organization was not found.',
			code: 'not_found',
		}
	}
	if (await isPersonalOrg(db, input.orgId)) {
		return {
			ok: false,
			error: 'Your personal organization identity is your account profile.',
			code: 'personal',
		}
	}

	const nextDisplayName =
		input.displayName === undefined
			? existing.display_name
			: input.displayName.trim()
	if (
		input.displayName !== undefined &&
		(!nextDisplayName || nextDisplayName.length > 80)
	) {
		return {
			ok: false,
			error: 'Enter a name up to 80 characters.',
			code: 'validation',
		}
	}

	if (
		input.slug !== undefined &&
		normalizeUsername(input.slug) !== existing.slug
	) {
		return { ok: false, error: orgSlugPermanentError, code: 'validation' }
	}

	const previousVisibility = await loadOrgProfileVisibility(db, input.orgId)
	const nextVisibility = input.profileVisibility ?? previousVisibility
	if (nextVisibility !== previousVisibility && !input.audit)
		throw new Error('Changing organization visibility needs an audit writer.')
	const now = new Date().toISOString()
	const update = db
		.prepare(
			`UPDATE orgs
			 SET display_name = ?,
			   profile_visibility = COALESCE(?, profile_visibility),
			   updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}
			   AND (? IS NULL OR profile_visibility = ?)`,
		)
		.bind(
			nextDisplayName,
			input.profileVisibility ?? null,
			now,
			input.orgId,
			// An explicit visibility applies only over the value it was read
			// against, so a stale request cannot undo a concurrent change.
			input.profileVisibility === undefined ? null : previousVisibility,
			previousVisibility,
		)
	let changed: boolean
	if (nextVisibility !== previousVisibility && input.audit) {
		// The change and its audit outbox row commit together.
		;({ changed } = await runAppDbBatchWithOrgAudit({
			appDb: db,
			audit: input.audit,
			statements: [update],
			onlyIfChanged: true,
			event: {
				orgId: input.orgId,
				action: 'org.profile_visibility_changed',
				details: {
					profile_visibility: nextVisibility,
					previous_profile_visibility: previousVisibility,
				},
			},
		}))
	} else {
		const result = await update.run()
		changed = (result.meta?.changes ?? 0) > 0
	}
	if (!changed && input.profileVisibility !== undefined) {
		return {
			ok: false,
			error:
				'Organization visibility changed while you were editing. Reload and try again.',
			code: 'conflict',
		}
	}

	return {
		ok: true,
		slug: existing.slug,
		displayName: nextDisplayName,
		profileVisibility: nextVisibility,
	}
}

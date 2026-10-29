import {
	normalizeUsername,
	orgSlugPermanentError,
} from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { recordOrgAuditEvent, type OrgAuditWriter } from './org-audit.ts'
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
			code: 'not_found' | 'personal' | 'validation'
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
	await db
		.prepare(
			`UPDATE orgs
			 SET display_name = ?, profile_visibility = ?, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(nextDisplayName, nextVisibility, now, input.orgId)
		.run()
	if (nextVisibility !== previousVisibility && input.audit) {
		await recordOrgAuditEvent(input.audit, {
			orgId: input.orgId,
			action: 'org.profile_visibility_changed',
			details: {
				profile_visibility: nextVisibility,
				previous_profile_visibility: previousVisibility,
			},
		})
	}

	return {
		ok: true,
		slug: existing.slug,
		displayName: nextDisplayName,
		profileVisibility: nextVisibility,
	}
}

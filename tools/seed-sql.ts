import { createHash } from 'node:crypto'
import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import type { FeatureFlagKey } from '#universal/feature-flags/registry.ts'
import { previewSeedFlagAllowlist } from './preview-seed-flag-allowlist.ts'

/**
 * SQL builders shared by the seeding CLI (`tools/seed-test-data.ts`), the E2E
 * D1 helpers (`e2e/d1-utils.ts`), and the MCP test support harness, so the
 * user/role seeding statements cannot drift between them.
 */

/**
 * Deterministic fixture `stable_user_id` for local seed accounts so re-seeding
 * and dependent seed rows (packages, integrations) resolve the same owner.
 * Production signup mints random ids (`mintPersonId`); never use this
 * outside local fixtures.
 */
export function seedStableUserIdFromEmail(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function storedStableUserIdSql(email: string) {
	return `(SELECT stable_user_id FROM users WHERE email = ${quoteSqlString(email)})`
}

/**
 * Deterministic TEXT ids for local metadata-only seed packages (and their
 * unique `source_id` values) so re-seeding upserts the same rows.
 */
export function seedSavedPackageIds(input: { email: string; index: number }): {
	packageId: string
	sourceId: string
} {
	const userId = seedStableUserIdFromEmail(input.email)
	const packageId = createHash('sha256')
		.update(`seed-saved-package:${userId}:${input.index}`)
		.digest('hex')
	const sourceId = createHash('sha256')
		.update(`seed-saved-package-source:${userId}:${input.index}`)
		.digest('hex')
	return { packageId, sourceId }
}

/**
 * Metadata-only `saved_packages` rows for local UI fixtures. No
 * `entity_sources`, artifacts, or ARTIFACTS binding — enough for account
 * pickers that list packages by `user_id`.
 */
export function buildSeedSavedPackagesSql(input: {
	email: string
	count: number
}) {
	const userId = storedStableUserIdSql(input.email)
	const statements: Array<string> = []
	for (let index = 1; index <= input.count; index += 1) {
		const { packageId, sourceId } = seedSavedPackageIds({
			email: input.email,
			index,
		})
		// Reserved fixture leaf so local UI seeds do not collide with a
		// hand-created package that happens to use `seed-pkg-N`.
		const name = `local-seed-pkg-${index}`
		const description = `Local seed metadata-only package ${index}`
		statements.push(
			`
INSERT INTO saved_packages (
	id, user_id, name, kody_id, description, tags_json, search_text,
	source_id, has_app, hidden, is_private
) VALUES (
	${quoteSqlString(packageId)}, ${userId}, ${quoteSqlString(name)},
	${quoteSqlString(name)}, ${quoteSqlString(description)}, '[]',
	${quoteSqlString(`${name} ${description}`)}, ${quoteSqlString(sourceId)},
	0, 0, 1
)
ON CONFLICT(id) DO UPDATE SET
	name = excluded.name,
	kody_id = excluded.kody_id,
	description = excluded.description,
	tags_json = excluded.tags_json,
	search_text = excluded.search_text,
	source_id = excluded.source_id,
	has_app = excluded.has_app,
	hidden = excluded.hidden,
	is_private = excluded.is_private,
	updated_at = CURRENT_TIMESTAMP;`.trim(),
		)
	}
	return statements.join('\n')
}

/**
 * Per-user feature-flag override (forced on) for a seeded account. Resolves
 * `users.id` by email so the FK matches the numeric override column.
 */
/**
 * Drop allowlisted preview-seed overrides this seed is not turning on.
 * Preview D1 is reused across deploys, and the upsert only forces flags on.
 */
export function buildClearUnrequestedPreviewSeedFlagsSql(input: {
	email: string
	enableFlags: ReadonlyArray<string>
}) {
	const requested = new Set(input.enableFlags)
	const clearKeys = previewSeedFlagAllowlist.filter(
		(key) => !requested.has(key),
	)
	if (clearKeys.length === 0) return ''
	const keys = clearKeys.map((key) => quoteSqlString(key)).join(', ')
	return `
DELETE FROM feature_flag_user_overrides
WHERE user_id = (SELECT id FROM users WHERE email = ${quoteSqlString(input.email)})
	AND flag_key IN (${keys});`.trim()
}

export function buildSeedFeatureFlagOverrideSql(input: {
	email: string
	flagKey: FeatureFlagKey
}) {
	const flagKey = quoteSqlString(input.flagKey)
	const email = quoteSqlString(input.email)
	return `
INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled, updated_by, updated_at)
SELECT ${flagKey}, u.id, 1, u.id, CURRENT_TIMESTAMP
FROM users u
WHERE u.email = ${email}
ON CONFLICT(flag_key, user_id) DO UPDATE SET
	enabled = excluded.enabled,
	updated_by = excluded.updated_by,
	updated_at = CURRENT_TIMESTAMP;`.trim()
}

export function buildRoleAssignmentSql(input: { email: string; role: string }) {
	return `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSqlString(input.email)} AND r.name = ${quoteSqlString(input.role)};`.trim()
}

function personalOrgSlugFromUsername(username: string) {
	return username.trim().toLowerCase()
}

/**
 * Personal org + owner membership + handle for a seeded fixture user
 * (`org_id = stable_user_id`, slug/handle = normalized username).
 */
export function buildSeedPersonalOrgSql(input: {
	stableUserId: string
	username: string
}) {
	const stableUserId = quoteSqlString(input.stableUserId)
	const slug = quoteSqlString(personalOrgSlugFromUsername(input.username))
	return `
INSERT INTO orgs (
	id,
	slug,
	display_name,
	bio,
	avatar_key,
	profile_visibility,
	plan,
	entitlement_ladder,
	stripe_customer_id,
	stripe_plan,
	stripe_price_id,
	stripe_plan_refreshed_at,
	stripe_credits_eligible,
	admin_credits_eligible,
	second_agent_standard_gift_granted_at,
	second_agent_standard_gift_expires_at,
	referral_standard_credit_expires_at,
	signup_welcome_credits_pending,
	created_by_user_id,
	created_at,
	updated_at
) VALUES (
	${stableUserId},
	${slug},
	NULL,
	NULL,
	NULL,
	'public',
	'free',
	'public',
	NULL,
	NULL,
	NULL,
	NULL,
	0,
	0,
	NULL,
	NULL,
	NULL,
	0,
	${stableUserId},
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP
)
ON CONFLICT(id) DO UPDATE SET
	slug = excluded.slug,
	updated_at = CURRENT_TIMESTAMP;
INSERT OR IGNORE INTO org_memberships (
	org_id, user_id, role, invited_by_user_id, created_at, deleted_at
) VALUES (
	${stableUserId}, ${stableUserId}, 'owner', NULL, CURRENT_TIMESTAMP, NULL
);
INSERT INTO handles (handle, user_id, org_id, created_at)
VALUES (${slug}, ${stableUserId}, ${stableUserId}, CURRENT_TIMESTAMP)
ON CONFLICT(handle) DO UPDATE SET
	user_id = excluded.user_id,
	org_id = excluded.org_id;`.trim()
}

function deletePersonalOrgRowsForStableUserIdsSubquery(
	stableUserIdSubquery: string,
) {
	return `
DELETE FROM org_memberships
WHERE org_id IN (${stableUserIdSubquery})
   OR user_id IN (${stableUserIdSubquery});
DELETE FROM handles
WHERE user_id IN (${stableUserIdSubquery})
   OR org_id IN (${stableUserIdSubquery});
DELETE FROM orgs WHERE id IN (${stableUserIdSubquery});`.trim()
}

/** Remove fixture users and their personal org rows (E2E / local re-seed). */
export function buildDeleteUserAndPersonalOrgSql(input: {
	emails: Array<string>
	/** Orphan org slugs when users were deleted without org cleanup. */
	orphanPersonalOrgSlugs?: Array<string>
}) {
	if (
		input.emails.length === 0 &&
		(input.orphanPersonalOrgSlugs?.length ?? 0) === 0
	) {
		return ''
	}
	const statements: Array<string> = []
	if (input.emails.length > 0) {
		const emailList = input.emails
			.map((email) => quoteSqlString(email))
			.join(', ')
		const stableUserIdSubquery = `SELECT stable_user_id FROM users WHERE email IN (${emailList})`
		statements.push(
			deletePersonalOrgRowsForStableUserIdsSubquery(stableUserIdSubquery),
		)
		statements.push(`DELETE FROM users WHERE email IN (${emailList});`)
	}
	const orphanSlugs = input.orphanPersonalOrgSlugs ?? []
	if (orphanSlugs.length > 0) {
		const slugList = orphanSlugs.map((slug) => quoteSqlString(slug)).join(', ')
		statements.push(
			`
DELETE FROM org_memberships
WHERE org_id IN (SELECT id FROM orgs WHERE slug IN (${slugList}));
DELETE FROM handles
WHERE handle IN (${slugList})
   OR org_id IN (SELECT id FROM orgs WHERE slug IN (${slugList}));
DELETE FROM orgs WHERE slug IN (${slugList});`.trim(),
		)
	}
	return statements.join('\n')
}

export function buildSeedUserSql(input: {
	email: string
	username: string
	passwordHash: string
	admin?: boolean
}) {
	// Org pages and the switcher parse `/@username/-/…` with the signup rule,
	// so a seeded account must hold a username signup would accept.
	if (!dnsSafeUsernamePattern.test(input.username)) {
		throw new Error(
			`Seed username "${input.username}" is not a valid username: 3 to 32 characters, letters, numbers, and hyphens, starting and ending with a letter or number.`,
		)
	}
	const roleSql = [
		buildRoleAssignmentSql({ email: input.email, role: 'user' }),
		...(input.admin
			? [buildRoleAssignmentSql({ email: input.email, role: 'admin' })]
			: []),
	].join('\n')

	const stableUserId = quoteSqlString(seedStableUserIdFromEmail(input.email))
	return `
INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, personal_org_id)
VALUES (${quoteSqlString(input.username)}, ${quoteSqlString(input.email)}, ${quoteSqlString(input.passwordHash)}, CURRENT_TIMESTAMP, ${stableUserId}, ${stableUserId})
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
  stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
  personal_org_id = COALESCE(NULLIF(TRIM(users.personal_org_id), ''), excluded.personal_org_id),
  updated_at = CURRENT_TIMESTAMP;
${buildSeedPersonalOrgSql({
	stableUserId: seedStableUserIdFromEmail(input.email),
	username: input.username,
})}
${roleSql}`.trim()
}

/**
 * A user-lane Google app with two connected accounts so /account/integrations
 * can exercise Disconnect and Delete integration without a live OAuth dance.
 */
export function buildSeedIntegrationSql(email: string) {
	const userId = storedStableUserIdSql(email)
	return `
INSERT INTO user_oauth_apps (
	user_id, slug, provider, label, client_id,
	token_url, authorize_url, api_base_url, flow, extra_authorize_params_json
) VALUES (
	${userId}, 'google', 'google', 'Google', 'seed-google-client',
	'https://oauth2.googleapis.com/token',
	'https://accounts.google.com/o/oauth2/v2/auth',
	'https://www.googleapis.com',
	'pkce', '{}'
)
ON CONFLICT(user_id, slug) DO UPDATE SET
	label = excluded.label,
	client_id = excluded.client_id,
	updated_at = CURRENT_TIMESTAMP;
INSERT INTO user_integrations (
	user_id, name, app_slug, platform_app_slug, account_label, description,
	scopes_json, required_hosts_json, connected_at
) VALUES
	(
		${userId}, 'google', 'google', NULL, 'Personal', '',
		'["openid","email"]', '["www.googleapis.com"]', CURRENT_TIMESTAMP
	),
	(
		${userId}, 'google-work', 'google', NULL, 'Work', '',
		'["openid","email"]', '["www.googleapis.com"]', CURRENT_TIMESTAMP
	)
ON CONFLICT(user_id, name) DO UPDATE SET
	account_label = excluded.account_label,
	app_slug = excluded.app_slug,
	updated_at = CURRENT_TIMESTAMP;`.trim()
}

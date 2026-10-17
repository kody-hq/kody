import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { assessAccountEmail } from '#worker/identity/account-email-policy.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	adminPasswordSetupTokenExpiryMs,
	createPasswordResetToken,
} from '#worker/identity/password-reset-tokens.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import {
	getAvailableGeneratedUsername,
	userExistsByUsername,
} from '#worker/identity/generated-username.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
} from '#worker/identity/email-claims.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { maybeGrantSignupWelcomeCredits } from '#worker/billing/signup-welcome-credits.ts'
import {
	mintPersonalOrgIdForSignup,
	provisionPersonalOrgForSignup,
	rollbackPersonalOrgAfterFailedSignup,
} from '#worker/orgs/signup-provision.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export type AdminCreateUserErrorCode =
	| 'invalid_email'
	| 'email_typo'
	| 'disposable_email'
	| 'email_domain_nxdomain'
	| 'email_domain_no_mx'
	| 'email_domain_null_mx'
	| 'invalid_username'
	| 'email_exists'
	| 'username_exists'
	| 'default_role_assignment_failed'
	| 'setup_token_failed'
	| 'create_failed'

export class AdminCreateUserError extends Error {
	readonly code: AdminCreateUserErrorCode

	constructor(code: AdminCreateUserErrorCode, message: string) {
		super(message)
		this.name = 'AdminCreateUserError'
		this.code = code
	}
}

export type AdminCreatedUser = {
	userId: number
	stableUserId: string
	email: string
	username: string
	setupLink: string
	setupTokenExpiresAt: number
}

async function resolveUsername(input: {
	db: D1Database
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
	email: string
	username?: string | null
}) {
	const explicitUsername = normalizeUsername(input.username)
	if (!explicitUsername) {
		return getAvailableGeneratedUsername(input.db, input.email, input.env)
	}

	const usernameError = await getEffectiveUsernameValidationError(
		explicitUsername,
		input.env,
	)
	if (usernameError) {
		throw new AdminCreateUserError('invalid_username', usernameError)
	}
	if (await userExistsByUsername(input.db, explicitUsername)) {
		throw new AdminCreateUserError(
			'username_exists',
			'Username already registered.',
		)
	}
	return explicitUsername
}

async function deleteUserBestEffort(input: {
	db: D1Database
	userId: number
	stableUserId: string
	personalOrgId?: string
}) {
	await rollbackPersonalOrgAfterFailedSignup(
		input.db,
		input.stableUserId,
		input.personalOrgId,
	)
	try {
		await input.db
			.prepare(`DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`)
			.bind(input.userId)
			.run()
	} catch (error) {
		console.error('Failed to roll back admin-created user:', error)
		return
	}
	// Use the known stable id: a post-DELETE SELECT would find nothing.
	invalidatePackageAppOwnerCache({ stableUserId: input.stableUserId })
}

function buildSetupLink(input: { origin: string; token: string }) {
	const setupUrl = new URL('/reset-password', input.origin)
	setupUrl.searchParams.set('token', input.token)
	return setupUrl.toString()
}

export async function adminCreateUserWithPasswordSetup(input: {
	db: D1Database
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
	email: string
	username?: string | null
	setupLinkOrigin: string | URL
	now?: Date
	/** Test seam for mail-domain DNS. Production callers omit it. */
	fetchImpl?: typeof fetch
}) {
	const emailDecision = await assessAccountEmail(input.email, {
		fetchImpl: input.fetchImpl,
	})
	if (!emailDecision.ok) {
		throw new AdminCreateUserError(emailDecision.code, emailDecision.error)
	}
	const email = normalizeEmail(emailDecision.email)
	if (!email) {
		throw new AdminCreateUserError(
			'invalid_email',
			'Enter a valid email address, like name@gmail.com.',
		)
	}

	const existingUser = await input.db
		.prepare(`SELECT id FROM users WHERE email = ?${andLiveDeletedAtSql()}`)
		.bind(email)
		.first<{ id: number }>()
	if (existingUser) {
		throw new AdminCreateUserError('email_exists', 'Email already registered.')
	}

	const username = await resolveUsername({
		db: input.db,
		env: input.env,
		email,
		username: input.username,
	})
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const allocated = await allocateSignupIdentity(input.db, email)
	if (!allocated.ok) {
		throw new AdminCreateUserError('email_exists', 'Email already registered.')
	}
	const stableUserId = allocated.stableUserId
	const personalOrgId = mintPersonalOrgIdForSignup()
	let userId: number | null = null

	try {
		const result = await input.db
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, email_verified_at,
					stable_user_id, personal_org_id
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				username,
				email,
				unusablePasswordHash.adminCreated,
				nowIso,
				stableUserId,
				personalOrgId,
			)
			.run()
		const lastRowId = result.meta.last_row_id
		if (!Number.isSafeInteger(lastRowId) || lastRowId < 1) {
			throw new AdminCreateUserError(
				'create_failed',
				'Unable to create account.',
			)
		}
		userId = lastRowId
		await provisionPersonalOrgForSignup(input.db, {
			stableUserId,
			orgId: personalOrgId,
			username,
			createdAt: nowIso,
			plan: 'free',
			signupWelcomeCreditsPending: 1,
		})
	} catch (error) {
		if (userId != null) {
			await deleteUserBestEffort({
				db: input.db,
				userId,
				stableUserId,
				personalOrgId,
			})
		}
		const uniqueField = getUniqueConstraintField(error)
		if (uniqueField === 'email') {
			throw new AdminCreateUserError(
				'email_exists',
				'Email already registered.',
			)
		}
		if (uniqueField === 'username') {
			throw new AdminCreateUserError(
				'username_exists',
				'Username already registered.',
			)
		}
		throw error
	}

	const { assigned } = await assignUserRole({
		db: input.db,
		userId,
		roleName: 'user',
	})
	if (!assigned) {
		await deleteUserBestEffort({
			db: input.db,
			userId,
			stableUserId,
			personalOrgId,
		})
		throw new AdminCreateUserError(
			'default_role_assignment_failed',
			'Unable to create account.',
		)
	}

	try {
		await claimAccountEmail(input.db, { userId, email, now })
	} catch (error) {
		await deleteUserBestEffort({
			db: input.db,
			userId,
			stableUserId,
			personalOrgId,
		})
		throw new AdminCreateUserError(
			'create_failed',
			error instanceof Error ? error.message : 'Unable to create account.',
		)
	}

	const setupTokenExpiresAt = now.getTime() + adminPasswordSetupTokenExpiryMs
	let resetToken: Awaited<ReturnType<typeof createPasswordResetToken>>
	try {
		resetToken = await createPasswordResetToken({
			db: input.db,
			userId,
			expiresAt: setupTokenExpiresAt,
		})
	} catch (error) {
		await deleteUserBestEffort({
			db: input.db,
			userId,
			stableUserId,
			personalOrgId,
		})
		throw new AdminCreateUserError(
			'setup_token_failed',
			error instanceof Error ? error.message : 'Unable to create setup link.',
		)
	}

	await maybeGrantSignupWelcomeCredits({
		db: input.db,
		userId: personalOrgId,
		now,
	})

	return {
		userId,
		stableUserId,
		email,
		username,
		setupTokenExpiresAt,
		setupLink: buildSetupLink({
			origin: new URL(input.setupLinkOrigin).origin,
			token: resetToken.token,
		}),
	} satisfies AdminCreatedUser
}

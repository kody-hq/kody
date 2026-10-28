import { maybeTagKitSubscriberOnSignup } from '#app/kit-signup.ts'
import {
	findSoftDeletedAccountsHoldingEmail,
	releaseSoftDeletedAccountsForEmail,
} from '#worker/identity/deleted-account-identity-release.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import {
	firstTouchAttributionCreateFields,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'
import { resolvePlanWrite } from '#universal/plans.ts'
import { resolveReferralCodeForSignup } from '#universal/referral-cookie.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { maybeGrantSignupWelcomeCredits } from '#worker/billing/signup-welcome-credits.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createDb, usersTable } from '#worker/db.ts'
import {
	maybeJoinOfficialDiscordGuild,
	maybeSyncDiscordGuildRolesForUser,
} from '#worker/discord/guild-role.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import { attributeReferralAtSignup } from '#worker/entitlements/referral-program.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
} from '#worker/identity/email-claims.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import {
	mintPersonalOrgIdForSignup,
	provisionPersonalOrgForSignup,
	rollbackPersonalOrgAfterFailedSignup,
} from '#worker/orgs/signup-provision.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OauthProviderId } from '#app/oauth-providers.ts'

const oauthNoUsablePasswordHash = unusablePasswordHash.oauthCreated

export type OauthSignupAccountFailureReason =
	| 'invalid_username'
	| 'username_exists'
	| 'former_email_claimed'
	| 'user_create_conflict'
	| 'default_role_assignment_failed'
	| 'email_claim_failed'
	| 'connection_create_failed'
	| 'connection_conflict'
	| 'org_provision_failed'

export type OauthSignupAccountResult =
	| {
			ok: true
			user: {
				id: number
				stable_user_id: string
				email: string
				username: string
			}
	  }
	| { ok: false; reason: OauthSignupAccountFailureReason }

/**
 * Create a user + personal org from a verified social identity and a chosen
 * permanent username. Callers hold the verified provider identity in
 * server-side pending state; this never trusts client-supplied email/provider ids.
 */
export async function createOauthSignupAccount(input: {
	env: Env
	provider: OauthProviderId
	providerUserId: string
	providerDisplayName: string | null
	email: string
	username: string
	attribution: FirstTouchAttribution | null
	accessToken: string | null
	requestIp?: string
	path: string
	cookieHeader: string | null
	searchParams?: URLSearchParams
}): Promise<OauthSignupAccountResult> {
	const env = input.env
	const db = createDb(env.APP_DB)
	const email = input.email
	const username = normalizeUsername(input.username)
	const provider = input.provider

	const usernameError = await getEffectiveUsernameValidationError(username, env)
	if (usernameError) {
		return { ok: false, reason: 'invalid_username' }
	}
	// The provider verified this email, so its owner supersedes any
	// soft-deleted account still holding it (and may reclaim its handle).
	// Superseding is irreversible: reject a username held by anyone else first.
	const releasable = await findSoftDeletedAccountsHoldingEmail(
		env.APP_DB,
		email,
	)
	if (await isUsernameClaimedInIdentity(env.APP_DB, username)) {
		// Its own username, handle, or personal org slug is reclaimable.
		let heldOnlyByReleasable = false
		for (const account of releasable) {
			if (
				!(await isUsernameClaimedInIdentity(env.APP_DB, username, {
					exceptStableUserId: account.stableUserId,
					exceptOrgId: account.personalOrgId,
				}))
			) {
				heldOnlyByReleasable = true
				break
			}
		}
		if (!heldOnlyByReleasable) return { ok: false, reason: 'username_exists' }
	}
	await releaseSoftDeletedAccountsForEmail(env.APP_DB, email)
	if (await isUsernameClaimedInIdentity(env.APP_DB, username)) {
		return { ok: false, reason: 'username_exists' }
	}

	let stableUserId: OwnerId
	let signupPersonalOrgId: OwnerId
	let newUser: {
		id: number
		stable_user_id: string
		email: string
		username: string
	} | null = null

	async function rollbackNewUser(userId: number) {
		invalidatePackageAppOwnerCache({ stableUserId })
		await rollbackPersonalOrgAfterFailedSignup(
			env.APP_DB,
			stableUserId,
			signupPersonalOrgId,
		)
		try {
			await env.APP_DB.prepare(
				`DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(userId)
				.run()
		} catch (rollbackError) {
			console.error(
				'Failed to roll back OAuth-created user row:',
				rollbackError,
			)
		}
	}

	try {
		const allocated = await allocateSignupIdentity(env.APP_DB, email)
		if (!allocated.ok) {
			if (allocated.reason === 'former_email_claimed') {
				return { ok: false, reason: 'former_email_claimed' }
			}
			return { ok: false, reason: 'user_create_conflict' }
		}
		stableUserId = personalOrgId(allocated.stableUserId)
		signupPersonalOrgId = mintPersonalOrgIdForSignup()
		recordOnboardingFunnelEvent(env, {
			stage: 'signup_started',
			userId: stableUserId,
		})
		const createdAt = new Date().toISOString()
		const createdUser = await db.create(
			usersTable,
			{
				username,
				email,
				stable_user_id: stableUserId,
				personal_org_id: signupPersonalOrgId,
				password_hash: oauthNoUsablePasswordHash,
				email_verified_at: createdAt,
				...firstTouchAttributionCreateFields(input.attribution),
				last_active_at: createdAt,
			},
			{ returnRow: true },
		)
		newUser = {
			id: createdUser.id,
			stable_user_id: stableUserId,
			email,
			username,
		}
		await provisionPersonalOrgForSignup(env.APP_DB, {
			stableUserId,
			orgId: signupPersonalOrgId,
			username,
			createdAt,
			plan: resolvePlanWrite(null),
			signupWelcomeCreditsPending: 1,
		})
	} catch (error) {
		if (newUser) {
			await rollbackNewUser(newUser.id)
		}
		const uniqueField = getUniqueConstraintField(error)
		if (uniqueField === 'stable_user_id' || uniqueField === 'personal_org_id') {
			return { ok: false, reason: 'former_email_claimed' }
		}
		if (uniqueField === 'username') {
			return { ok: false, reason: 'username_exists' }
		}
		if (uniqueField) {
			return { ok: false, reason: 'user_create_conflict' }
		}
		throw error
	}

	if (!newUser) {
		return { ok: false, reason: 'user_create_conflict' }
	}

	let assigned = false
	try {
		;({ assigned } = await assignUserRole({
			db: env.APP_DB,
			userId: newUser.id,
			roleName: 'user',
		}))
	} catch (error) {
		console.error('Failed to assign default role at OAuth signup:', error)
	}
	if (!assigned) {
		await rollbackNewUser(newUser.id)
		return { ok: false, reason: 'default_role_assignment_failed' }
	}

	try {
		await claimAccountEmail(env.APP_DB, {
			userId: newUser.id,
			email,
		})
	} catch (error) {
		console.error('Failed to claim OAuth signup email:', error)
		await rollbackNewUser(newUser.id)
		return { ok: false, reason: 'email_claim_failed' }
	}

	try {
		const inserted = await env.APP_DB.prepare(
			`INSERT INTO oauth_connections (
				provider_name, provider_id, user_id, provider_display_name
			)
			 SELECT ?, ?, id, ?
			 FROM users
			 WHERE id = ? AND deleting_at IS NULL`,
		)
			.bind(
				provider,
				input.providerUserId,
				input.providerDisplayName,
				newUser.id,
			)
			.run()
		if ((inserted.meta.changes ?? 0) !== 1) {
			await rollbackNewUser(newUser.id)
			return { ok: false, reason: 'connection_create_failed' }
		}
	} catch (error) {
		console.error('Failed to store OAuth connection at signup:', error)
		if (getUniqueConstraintField(error)) {
			await rollbackNewUser(newUser.id)
			return { ok: false, reason: 'connection_conflict' }
		}
		await rollbackNewUser(newUser.id)
		return { ok: false, reason: 'connection_create_failed' }
	}

	if (provider === 'discord') {
		await maybeJoinOfficialDiscordGuild({
			env,
			discordUserId: input.providerUserId,
			accessToken: input.accessToken,
		})
		await maybeSyncDiscordGuildRolesForUser({
			env,
			userId: newUser.id,
			discordUserId: input.providerUserId,
		})
	}

	const platformEmailDomain = getPlatformEmailDomain(env)
	if (platformEmailDomain) {
		try {
			await ensureDefaultEmailInbox({
				db: env.APP_DB,
				userId: signupPersonalOrgId,
				actorPersonId: stableUserId,
				username,
				domain: platformEmailDomain,
			})
		} catch (error) {
			console.warn(
				'Failed to provision default email inbox at OAuth signup:',
				error,
			)
		}
	}

	await maybeTagKitSubscriberOnSignup({ env, email })
	scheduleKitSubscriberSync({
		env,
		email,
		stableUserId,
	})
	scheduleUserCreatedEvent({
		env,
		user: {
			id: stableUserId,
			username,
			email,
		},
		source: 'oauth',
		attribution: input.attribution,
	})
	await maybeGrantSignupWelcomeCredits({
		db: env.APP_DB,
		userId: signupPersonalOrgId,
	})
	try {
		await attributeReferralAtSignup({
			db: env.APP_DB,
			refereeStableUserId: stableUserId,
			refereeUsername: username,
			referralCode: resolveReferralCodeForSignup({
				searchParams: input.searchParams ?? new URLSearchParams(),
				cookieHeader: input.cookieHeader,
			}),
		})
	} catch (error) {
		console.warn('referral-attribution-failed', error)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'oauth_signup',
		result: 'success',
		email,
		ip: input.requestIp,
		path: input.path,
		reason: `provider=${provider}`,
	})
	recordOnboardingFunnelEvent(env, {
		stage: 'signup_completed',
		userId: stableUserId,
	})
	recordOnboardingFunnelEvent(env, {
		stage: 'email_verified',
		userId: stableUserId,
	})

	return { ok: true, user: newUser }
}

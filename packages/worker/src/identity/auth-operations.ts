import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { authOperationResult } from './auth-operation-result.ts'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
} from '#app/auth-session.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createEmailVerification } from '#app/email-verification.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { isUsernameClaimedInIdentity } from '#worker/identity/generated-username.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { upgradePasswordHashIfNeeded } from '#worker/password-upgrade.ts'
import { resolvePlanWrite } from '#universal/plans.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import {
	formerEmailClaimedSignupCode,
	formerEmailClaimedSignupMessage,
} from '#universal/email-claim-errors.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
} from '#worker/identity/email-claims.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { maybeTagKitSubscriberOnSignup } from '#app/kit-signup.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { checkPublicFormProtection } from '#app/public-form-protection.ts'
import {
	firstTouchAttributionCreateFields,
	parseFirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'
import {
	resolveReferralCodeForSignup,
	serializeReferralCookie,
} from '#universal/referral-cookie.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import {
	maybeGrantSignupWelcomeCredits,
	reconcileSignupWelcomeCreditsIfPending,
} from '#worker/billing/signup-welcome-credits.ts'
import { attributeReferralAtSignup } from '#worker/entitlements/referral-program.ts'
import {
	mintPersonalOrgIdForSignup,
	provisionPersonalOrgForSignup,
	rollbackPersonalOrgAfterFailedSignup,
} from '#worker/orgs/signup-provision.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const authModes = ['login', 'signup'] as const
type AuthMode = (typeof authModes)[number]

const authRequestSchema = object({
	email: string(),
	password: string(),
	mode: enum_(authModes),
})

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'

function signupUniqueConflict(
	uniqueField: 'email' | 'username' | 'stable_user_id' | 'personal_org_id',
) {
	switch (uniqueField) {
		case 'username':
			return {
				reason: 'username_exists',
				error: 'Username already registered.',
			}
		case 'email':
			return {
				reason: 'email_exists',
				error: 'Email already registered.',
			}
		case 'stable_user_id':
		case 'personal_org_id':
			return {
				reason: 'former_email_claimed',
				error: formerEmailClaimedSignupMessage,
			}
		default: {
			const exhaustive: never = uniqueField
			throw new Error(`Unhandled unique field: ${String(exhaustive)}`)
		}
	}
}

function signupAcceptedBody(mode: AuthMode) {
	return {
		ok: true,
		mode,
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	}
}

export async function authenticateWebsite({
	env,
	request,
	url,
	body,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
}) {
	const db = createDb(env.APP_DB)

	const protection = await checkPublicFormProtection({
		env,
		request,
		body:
			typeof body === 'object' && body !== null
				? (body as Record<string, unknown>)
				: {},
	})
	if (!protection.ok)
		return authOperationResult({ error: protection.error }, 400)

	const parsedBody = parseSafe(authRequestSchema, body)
	if (!parsedBody.success) {
		return authOperationResult(
			{ error: 'Invalid request body.' },
			{ status: 400 },
		)
	}

	const normalizedEmail = normalizeEmail(parsedBody.value.email)
	const normalizedPassword = parsedBody.value.password
	const normalizedMode: AuthMode = parsedBody.value.mode
	const normalizedUsername = normalizeUsername(
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>).username
			: undefined,
	)
	const signupAttribution =
		normalizedMode === 'signup'
			? parseFirstTouchAttribution({
					body: typeof body === 'object' && body !== null ? body : undefined,
				})
			: null
	const rememberMeValue =
		typeof body === 'object' && body !== null
			? (body as Record<string, unknown>).rememberMe
			: undefined
	const signupRedirectTo =
		normalizedMode === 'signup' &&
		typeof body === 'object' &&
		body !== null &&
		typeof (body as Record<string, unknown>).redirectTo === 'string'
			? normalizeRedirectTo(
					(body as Record<string, unknown>).redirectTo as string,
				)
			: null
	const requestIp = getRequestIp(request) ?? undefined
	if (rememberMeValue !== undefined && typeof rememberMeValue !== 'boolean') {
		return authOperationResult(
			{ error: 'Invalid request body.' },
			{ status: 400 },
		)
	}
	const rememberMe = normalizedMode === 'login' && rememberMeValue === true

	if (!normalizedEmail || !normalizedPassword) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'authenticate',
			result: 'failure',
			email: normalizedEmail || undefined,
			ip: requestIp,
			path: url.pathname,
			reason: 'missing_fields',
		})
		return authOperationResult(
			{ error: 'Email, password, and mode are required.' },
			{ status: 400 },
		)
	}
	if (normalizedMode === 'signup') {
		const usernameError = await getEffectiveUsernameValidationError(
			normalizedUsername,
			env,
		)
		if (usernameError) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'invalid_username',
			})
			return authOperationResult({ error: usernameError }, { status: 400 })
		}
		const passwordError = getPasswordPolicyError(normalizedPassword)
		if (passwordError) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'weak_password',
			})
			return authOperationResult({ error: passwordError }, { status: 400 })
		}
	}

	if (normalizedMode === 'signup') {
		if (await isUsernameClaimedInIdentity(env.APP_DB, normalizedUsername)) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'username_exists',
			})
			return authOperationResult(
				{ error: 'Username already registered.' },
				{ status: 409 },
			)
		}

		const passwordHash = await createPasswordHash(normalizedPassword)

		// Same body and status as a fresh signup so the endpoint does
		// not confirm which addresses hold accounts. Nothing is created
		// or sent.
		const existingUser = await db.findOne(usersTable, {
			where: { email: normalizedEmail },
		})
		if (existingUser) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'email_exists',
			})
			return authOperationResult(signupAcceptedBody(normalizedMode))
		}

		const allocated = await allocateSignupIdentity(env.APP_DB, normalizedEmail)
		if (allocated.ok) {
			recordOnboardingFunnelEvent(env, {
				stage: 'signup_started',
				userId: allocated.stableUserId,
			})
		}
		if (!allocated.ok) {
			if (allocated.reason === 'current_email') {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'signup',
					result: 'failure',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_exists',
				})
				return authOperationResult(signupAcceptedBody(normalizedMode))
			}
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'former_email_claimed',
			})
			return authOperationResult(
				{
					error: formerEmailClaimedSignupMessage,
					code: formerEmailClaimedSignupCode,
				},
				{ status: 409 },
			)
		}

		let record: {
			id: number
			stableUserId: string
			personalOrgId: string
		} | null = null
		const signupCreatedAt = new Date().toISOString()
		try {
			const stableUserId = allocated.stableUserId
			const personalOrgId = mintPersonalOrgIdForSignup()
			const createdAt = signupCreatedAt
			const createdUser = await db.create(
				usersTable,
				{
					username: normalizedUsername,
					email: normalizedEmail,
					stable_user_id: stableUserId,
					personal_org_id: personalOrgId,
					password_hash: passwordHash,
					...firstTouchAttributionCreateFields(signupAttribution),
					last_active_at: createdAt,
				},
				{
					returnRow: true,
				},
			)
			record = { id: createdUser.id, stableUserId, personalOrgId }
		} catch (error) {
			const uniqueField = getUniqueConstraintField(error)
			if (
				uniqueField === 'email' ||
				uniqueField === 'username' ||
				uniqueField === 'stable_user_id' ||
				uniqueField === 'personal_org_id'
			) {
				const conflict = signupUniqueConflict(uniqueField)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'signup',
					result: 'failure',
					email: normalizedEmail,
					ip: requestIp,
					path: url.pathname,
					reason: conflict.reason,
				})
				// A concurrent signup that lost the race on `email` must not
				// leak the address either; only public identifiers get a 409.
				if (uniqueField === 'email') {
					return authOperationResult(signupAcceptedBody(normalizedMode))
				}
				return authOperationResult(
					uniqueField === 'stable_user_id' || uniqueField === 'personal_org_id'
						? {
								error: conflict.error,
								code: formerEmailClaimedSignupCode,
							}
						: { error: conflict.error },
					{ status: 409 },
				)
			}
			throw error
		}
		if (!record) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'insert_failed',
			})
			return authOperationResult(
				{ error: 'Unable to create account.' },
				{ status: 500 },
			)
		}

		const signupUser = record
		try {
			await provisionPersonalOrgForSignup(env.APP_DB, {
				stableUserId: signupUser.stableUserId,
				orgId: signupUser.personalOrgId,
				username: normalizedUsername,
				createdAt: signupCreatedAt,
				plan: resolvePlanWrite(null),
				signupWelcomeCreditsPending: 1,
			})
		} catch (error) {
			console.error('Failed to provision personal org at signup:', error)
			invalidatePackageAppOwnerCache({
				stableUserId: signupUser.stableUserId,
			})
			try {
				await rollbackPersonalOrgAfterFailedSignup(
					env.APP_DB,
					signupUser.stableUserId,
					signupUser.personalOrgId,
				)
				await env.APP_DB.prepare(
					`DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
				)
					.bind(signupUser.id)
					.run()
			} catch (deleteError) {
				console.error(
					'Failed to remove user row after org provision failure:',
					deleteError,
				)
			}
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'org_provision_failed',
			})
			return authOperationResult(
				{ error: 'Unable to create account.' },
				{ status: 500 },
			)
		}

		async function removeFailedSignupUser() {
			invalidatePackageAppOwnerCache({
				stableUserId: signupUser.stableUserId,
			})
			await rollbackPersonalOrgAfterFailedSignup(
				env.APP_DB,
				signupUser.stableUserId,
				signupUser.personalOrgId,
			)
			await env.APP_DB.prepare(
				`DELETE FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(signupUser.id)
				.run()
		}

		// INSERT OR IGNORE affects zero rows when the seeded `user` role is
		// missing (partial migration). Fail loudly rather than creating an
		// account with no roles or permissions.
		let assigned = false
		try {
			;({ assigned } = await assignUserRole({
				db: env.APP_DB,
				userId: record.id,
				roleName: 'user',
			}))
		} catch (error) {
			console.error('Failed to assign default role at signup:', error)
		}
		if (!assigned) {
			// Remove the just-created user row so the signup can be retried;
			// otherwise the email/username would be stuck as "already
			// registered" on an account that has no roles.
			try {
				await removeFailedSignupUser()
			} catch (error) {
				console.error(
					'Failed to remove user row after role assignment failure:',
					error,
				)
			}
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'default_role_assignment_failed',
			})
			return authOperationResult(
				{ error: 'Unable to create account.' },
				{ status: 500 },
			)
		}

		try {
			await claimAccountEmail(env.APP_DB, {
				userId: record.id,
				email: normalizedEmail,
			})
		} catch (error) {
			console.error('Failed to claim signup email:', error)
			try {
				await removeFailedSignupUser()
			} catch (deleteError) {
				console.error(
					'Failed to remove user row after email claim failure:',
					deleteError,
				)
			}
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'email_claim_failed',
			})
			return authOperationResult(
				{ error: 'Unable to create account.' },
				{ status: 500 },
			)
		}

		try {
			await createEmailVerification({
				env,
				userId: record.id,
				email: normalizedEmail,
				requestUrl: url,
				redirectTo: signupRedirectTo,
			})
		} catch (error) {
			console.error('Failed to create email verification at signup:', error)
			try {
				await removeFailedSignupUser()
			} catch (deleteError) {
				console.error(
					'Failed to remove user row after verification setup failure:',
					deleteError,
				)
			}
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'signup',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				path: url.pathname,
				reason: 'email_verification_setup_failed',
			})
			return authOperationResult(
				{
					error:
						'Unable to send the verification email. Please try signing up again.',
				},
				{ status: 500 },
			)
		}

		// Best-effort: the automatic {username}@<platform domain> inbox is
		// also provisioned on first inbound mail, so a failure here must
		// not fail the signup.
		const platformEmailDomain = getPlatformEmailDomain(env)
		if (platformEmailDomain) {
			try {
				await ensureDefaultEmailInbox({
					db: env.APP_DB,
					userId: record.personalOrgId,
					actorPersonId: record.stableUserId,
					username: normalizedUsername,
					domain: platformEmailDomain,
				})
			} catch (error) {
				console.warn(
					'Failed to provision default email inbox at signup:',
					error,
				)
			}
		}

		// Best-effort: if this email is already in Kit,
		// add signed_up::kody without removing other tags.
		await maybeTagKitSubscriberOnSignup({
			env,
			email: normalizedEmail,
		})
		scheduleKitSubscriberSync({
			env,
			email: normalizedEmail,
			stableUserId: record.stableUserId,
		})
		scheduleUserCreatedEvent({
			env,
			user: {
				id: record.stableUserId,
				username: normalizedUsername,
				email: normalizedEmail,
			},
			source: 'signup',
			attribution: signupAttribution,
		})
		await maybeGrantSignupWelcomeCredits({
			db: env.APP_DB,
			userId: record.personalOrgId,
		})
		try {
			await attributeReferralAtSignup({
				db: env.APP_DB,
				refereeStableUserId: record.stableUserId,
				refereeUsername: normalizedUsername,
				referralCode: resolveReferralCodeForSignup({
					body: typeof body === 'object' && body !== null ? body : undefined,
					cookieHeader: request.headers.get('Cookie'),
				}),
			})
		} catch (error) {
			console.warn('referral-attribution-failed', error)
		}

		const secure = isSecureRequest(request)
		const cookie = await createAuthCookie(
			{
				stableUserId: record.stableUserId,
				email: normalizedEmail,
				rememberMe: false,
			},
			secure,
		)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'signup',
			result: 'success',
			email: normalizedEmail,
			ip: requestIp,
			path: url.pathname,
		})
		recordOnboardingFunnelEvent(env, {
			stage: 'signup_completed',
			userId: record.stableUserId,
		})
		const headers = new Headers()
		headers.append('Set-Cookie', cookie)
		headers.append(
			'Set-Cookie',
			serializeReferralCookie({ code: null, secure }),
		)
		return authOperationResult(signupAcceptedBody(normalizedMode), { headers })
	}

	const userRecord = await db.findOne(usersTable, {
		where: { email: normalizedEmail },
	})
	const liveUserRecord = userRecord?.deleted_at ? null : userRecord
	let passwordValid = false
	if (liveUserRecord) {
		passwordValid = await verifyPassword(
			normalizedPassword,
			liveUserRecord.password_hash,
		)
	} else {
		await verifyPassword(normalizedPassword, dummyPasswordHash)
	}
	if (!liveUserRecord || !passwordValid) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'login',
			result: 'failure',
			email: normalizedEmail,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_credentials',
		})
		return authOperationResult(
			{ error: 'Invalid email or password.' },
			{ status: 401 },
		)
	}

	try {
		await upgradePasswordHashIfNeeded(
			db,
			liveUserRecord.id,
			normalizedPassword,
			liveUserRecord.password_hash,
		)
	} catch {
		// A failed hash upgrade must never block an otherwise valid login.
	}

	// Two-factor accounts get a short-lived pending cookie instead of a
	// session; the real session cookie is only issued once the TOTP code
	// passes at POST /verify/2fa.json.
	if (await isTwoFactorEnabled(env.APP_DB, liveUserRecord.id)) {
		setVerifySessionSecret(env.COOKIE_SECRET)
		const secure = isSecureRequest(request)
		const verifyCookie = await createVerifySessionCookie(
			{
				stableUserId: personIdFromStored(liveUserRecord.stable_user_id),
				email: normalizedEmail,
				rememberMe,
			},
			secure,
		)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'login_2fa_challenge',
			result: 'success',
			email: normalizedEmail,
			ip: requestIp,
			path: url.pathname,
		})
		const headers = new Headers()
		headers.append('Set-Cookie', verifyCookie)
		// A pre-existing session must not stay usable while the second
		// factor is still pending for this new login.
		headers.append('Set-Cookie', await destroyAuthCookie(secure))
		return authOperationResult(
			{ ok: true, mode: normalizedMode, requiresTwoFactor: true },
			{ headers },
		)
	}

	const stableUserId = personIdFromStored(liveUserRecord.stable_user_id)
	const cookie = await createAuthCookie(
		{
			stableUserId,
			email: normalizedEmail,
			rememberMe,
		},
		isSecureRequest(request),
	)
	await touchLastActiveAt(env.APP_DB, {
		stableUserId,
	})
	await reconcileSignupWelcomeCreditsIfPending({
		db: env.APP_DB,
		userId: personalOrgIdFromUserRow(liveUserRecord),
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'login',
		result: 'success',
		email: normalizedEmail,
		ip: requestIp,
		path: url.pathname,
	})
	return authOperationResult(
		{ ok: true, mode: normalizedMode },
		{
			headers: {
				'Set-Cookie': cookie,
			},
		},
	)
}

import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { applyPasswordChange } from '#app/apply-password-change.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { clearedFactorsAuditReason } from '#app/clear-account-factors.ts'
import { maybeTagKitSubscriberOnSignup } from '#app/kit-signup.ts'
import {
	destroyOauthLoginStateCookie,
	readOauthLoginState,
	setOauthLoginStateSecret,
} from '#app/oauth-login-state.ts'
import {
	getOauthClientConfig,
	isOauthProviderId,
	resolveOauthProfile,
	type OauthProfile,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { withAccountCreatedQuery } from '#universal/fathom-events.ts'
import { firstTouchAttributionCreateFields } from '#universal/first-touch-attribution.ts'
import { type OauthLoginErrorCode } from '#universal/oauth-login-errors.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import {
	assessAccountEmail,
	type AccountEmailRejectionCode,
} from '#worker/identity/account-email-policy.ts'
import { resolvePlanWrite } from '#universal/plans.ts'
import {
	resolveReferralCodeForSignup,
	serializeReferralCookie,
} from '#universal/referral-cookie.ts'
import { routes } from '#universal/routes.ts'
import {
	defaultPostVerificationRedirect,
	resolvePostAuthLandingPath,
} from '#universal/safe-redirect.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritableDb,
} from '#worker/account/deletion-state.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	maybeGrantSignupWelcomeCredits,
	reconcileSignupWelcomeCreditsIfPending,
} from '#worker/billing/signup-welcome-credits.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createDb, oauthConnectionsTable, usersTable } from '#worker/db.ts'
import {
	maybeJoinOfficialDiscordGuild,
	maybeSyncDiscordGuildRolesForUser,
} from '#worker/discord/guild-role.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import { attributeReferralAtSignup } from '#worker/entitlements/referral-program.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
} from '#worker/identity/email-claims.ts'
import { getAvailableUsernameFromBase } from '#worker/identity/generated-username.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { getCallbackRedirectUri } from '#worker/identity/oauth-provider-redirect.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { usernameFromEmail } from '#worker/identity/username.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import {
	mintPersonalOrgIdForSignup,
	provisionPersonalOrgForSignup,
	rollbackPersonalOrgAfterFailedSignup,
} from '#worker/orgs/signup-provision.ts'
import {
	personIdFromStored,
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Accounts created through social login have no usable password until the
 * user sets one via password reset; verifyPassword rejects this sentinel.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const oauthNoUsablePasswordHash = unusablePasswordHash.oauthCreated

function oauthCodeForAccountEmail(
	code: AccountEmailRejectionCode,
): OauthLoginErrorCode {
	switch (code) {
		case 'invalid_email':
			return 'email-invalid'
		case 'email_typo':
			return 'email-typo'
		case 'disposable_email':
			return 'email-disposable'
		case 'email_domain_nxdomain':
		case 'email_domain_no_mx':
		case 'email_domain_null_mx':
			return 'email-undeliverable'
		default: {
			const exhaustive: never = code
			throw new Error(`Unhandled account email code: ${String(exhaustive)}`)
		}
	}
}

function redirect(location: string, cookies: Array<string>) {
	const headers = new Headers({ Location: location })
	for (const cookie of cookies) {
		headers.append('Set-Cookie', cookie)
	}
	return new Response(null, { status: 302, headers })
}

function redirectToLoginWithError(
	code: OauthLoginErrorCode,
	cookies: Array<string> = [],
	redirectTo: string | null = null,
) {
	// Keep the deep-link target alive across failures so retrying from the
	// login page still lands the user where they were headed.
	const redirectToSuffix = redirectTo
		? `&redirectTo=${encodeURIComponent(redirectTo)}`
		: ''
	return redirect(`/login?oauthError=${code}${redirectToSuffix}`, cookies)
}

function oauthResultLocation(
	path: string,
	key: 'oauthLinked' | 'oauthError',
	value: string,
) {
	const url = new URL(path, 'https://kody.local')
	url.searchParams.set(key, value)
	return `${url.pathname}${url.search}${url.hash}`
}

function signedInOauthReturnLocation(
	redirectTo: string | null,
	key: 'oauthLinked' | 'oauthError',
	value: string,
) {
	return oauthResultLocation(
		redirectTo ?? routes.accountSecurity.href(),
		key,
		value,
	)
}

/**
 * The login and connections UIs start flows via fetch (Accept: json) and
 * navigate to the returned authorize URL themselves: the CSP locks
 * `form-action`/`connect-src` to 'self', so neither a form POST redirect nor
 * a fetch-followed redirect may leave the origin — but a top-level JS
 * navigation may.
 */
export function createAuthProviderCallbackHandler(env: Env) {
	const db = createDb(env.APP_DB)

	async function createConnection(input: {
		provider: OauthProviderId
		profile: OauthProfile
		userId: number
		requireVerifiedEmail?: boolean
	}) {
		const insertSql = input.requireVerifiedEmail
			? `INSERT INTO oauth_connections (
				provider_name, provider_id, user_id, provider_display_name
			)
			 SELECT ?, ?, id, ?
			 FROM users
			 WHERE id = ? AND email_verified_at IS NOT NULL AND deleting_at IS NULL`
			: `INSERT INTO oauth_connections (
				provider_name, provider_id, user_id, provider_display_name
			)
			 SELECT ?, ?, id, ?
			 FROM users
			 WHERE id = ? AND deleting_at IS NULL`
		const inserted = await env.APP_DB.prepare(insertSql)
			.bind(
				input.provider,
				input.profile.providerUserId,
				input.profile.username ?? input.profile.displayName ?? null,
				input.userId,
			)
			.run()
		if ((inserted.meta.changes ?? 0) !== 1) {
			throw new AccountDeletionInProgressError()
		}
	}

	async function completeDiscordGuildLogin(input: {
		provider: OauthProviderId
		userId: number
		discordUserId: string
		accessToken: string | null
	}) {
		if (input.provider !== 'discord') return
		await maybeJoinOfficialDiscordGuild({
			env,
			discordUserId: input.discordUserId,
			accessToken: input.accessToken,
		})
		await maybeSyncDiscordGuildRolesForUser({
			env,
			userId: input.userId,
			discordUserId: input.discordUserId,
		})
	}

	return async ({
		request,
		params,
	}: {
		request: Request
		params: { provider: string }
	}) => {
		const url = new URL(request.url)

		setOauthLoginStateSecret(env.COOKIE_SECRET)
		const secure = isSecureRequest(request)
		const clearStateCookie = await destroyOauthLoginStateCookie(secure)
		const requestIp = getRequestIp(request) ?? undefined
		const loginState = await readOauthLoginState(request)
		const redirectTo = normalizeRedirectTo(loginState?.redirectTo ?? null)
		const { session } = await readAuthSessionResult(request)

		function fail(code: OauthLoginErrorCode, reason: string) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'oauth_login',
				result: 'failure',
				ip: requestIp,
				path: url.pathname,
				reason,
			})
			// A signed-in user is connecting a provider from their account
			// page; bouncing them to /login would immediately redirect back
			// and drop the message.
			if (session) {
				return redirect(
					signedInOauthReturnLocation(redirectTo, 'oauthError', code),
					[clearStateCookie],
				)
			}
			return redirectToLoginWithError(code, [clearStateCookie], redirectTo)
		}

		const providerParam = params.provider
		if (!isOauthProviderId(providerParam)) {
			return fail('unknown-provider', 'unknown_provider')
		}
		const provider = providerParam
		if (!getOauthClientConfig(env, provider)) {
			return fail('not-configured', 'provider_not_configured')
		}

		if (url.searchParams.get('error')) {
			return fail('denied', 'provider_denied')
		}

		const stateFromQuery = url.searchParams.get('state')
		const code = url.searchParams.get('code')
		if (
			!loginState ||
			loginState.provider !== provider ||
			!stateFromQuery ||
			stateFromQuery !== loginState.state ||
			!code
		) {
			return fail('state-mismatch', 'state_mismatch')
		}

		let profile: OauthProfile
		let accessToken: string | null = null
		try {
			;({ profile, accessToken } = await resolveOauthProfile({
				env,
				provider,
				code,
				codeVerifier: loginState.codeVerifier,
				redirectUri: getCallbackRedirectUri(env, url, provider),
			}))
		} catch (error) {
			console.error('OAuth login provider exchange failed:', error)
			return fail('provider-error', 'provider_exchange_failed')
		}

		async function issueLogin(
			user: {
				id: number
				stable_user_id: string | null
				email: string
			},
			/**
			 * Where to land when the request carried no explicit `redirectTo`.
			 * Returning users go to their account; a freshly created account
			 * gets the same onboarding destination password signups reach
			 * after verification, since the provider already proved the email.
			 */
			defaultRedirectTo = '/account',
			options: {
				/**
				 * Absolute post-login destination. When set, wins over both the
				 * OAuth-state redirectTo and defaultRedirectTo (used so new
				 * signups can append accountCreated=1 for Fathom).
				 */
				destination?: string
				/**
				 * Cookie `issuedAt`. Reclaim stamps `password_changed_at` first,
				 * so the new session must postdate that timestamp.
				 */
				issuedAt?: number
				/** Drop the last-wins share cookie after a new account is created. */
				clearReferralCookie?: boolean
			} = {},
		) {
			// Authentication sessions are person-owned.
			const stableUserId = personalOrgId(
				personIdFromStored(user.stable_user_id),
			)
			const rawPostLoginPath =
				options.destination ?? redirectTo ?? defaultRedirectTo
			// Authorize resumes drop prompt=login after this completed auth
			// so consent can use the session cookie just issued.
			const postLoginPath =
				resolvePostAuthLandingPath(rawPostLoginPath) ?? rawPostLoginPath
			// Two-factor accounts get the same pending-verification gate as
			// password and passkey logins; the session cookie is only
			// issued once the TOTP code passes.
			if (await isTwoFactorEnabled(env.APP_DB, user.id)) {
				setVerifySessionSecret(env.COOKIE_SECRET)
				const verifyCookie = await createVerifySessionCookie(
					{ stableUserId, email: user.email, rememberMe: false },
					secure,
				)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'oauth_login_2fa_challenge',
					result: 'success',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: `provider=${provider}`,
				})
				const verifyPath = redirectTo
					? `/verify?redirectTo=${encodeURIComponent(redirectTo)}`
					: '/verify'
				const cookies = [
					verifyCookie,
					await destroyAuthCookie(secure),
					clearStateCookie,
				]
				if (options.clearReferralCookie) {
					cookies.push(serializeReferralCookie({ code: null, secure }))
				}
				return redirect(verifyPath, cookies)
			}

			const sessionCookie = await createAuthCookie(
				{ stableUserId, email: user.email, rememberMe: false },
				secure,
				options.issuedAt ?? Date.now(),
			)
			await touchLastActiveAt(env.APP_DB, { stableUserId })
			await reconcileSignupWelcomeCreditsIfPending({
				db: env.APP_DB,
				userId: await loadPersonalOrgIdForPerson(
					env.APP_DB,
					personIdFromStored(user.stable_user_id),
				),
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'oauth_login',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: `provider=${provider}`,
			})
			const cookies = [sessionCookie, clearStateCookie]
			if (options.clearReferralCookie) {
				cookies.push(serializeReferralCookie({ code: null, secure }))
			}
			return redirect(postLoginPath, cookies)
		}

		const connection = await db.findOne(oauthConnectionsTable, {
			where: {
				provider_name: provider,
				provider_id: profile.providerUserId,
			},
		})

		// 1. A signed-in user links the provider identity to their account
		// (an existing connection for another user is a conflict, never an
		// account switch).
		if (session) {
			const currentUser = await db.findOne(usersTable, {
				where: { stable_user_id: session.stableUserId },
			})
			if (!currentUser || currentUser.deleted_at) {
				return fail('account-error', 'session_user_missing')
			}
			// Check the live users row, not the session cookie. A password
			// squat must not attach a provider and skip the unverified
			// account purge; this sits before any oauth_connections write.
			if (currentUser.email_verified_at == null) {
				return fail('email-unverified', 'email_unverified')
			}
			if (connection) {
				if (connection.user_id === currentUser.id) {
					await completeDiscordGuildLogin({
						provider,
						userId: currentUser.id,
						discordUserId: profile.providerUserId,
						accessToken,
					})
					return redirect(
						signedInOauthReturnLocation(redirectTo, 'oauthLinked', provider),
						[clearStateCookie],
					)
				}
				return fail('connection-conflict', 'connection_conflict')
			}
			try {
				await createConnection({
					provider,
					profile,
					userId: currentUser.id,
					requireVerifiedEmail: true,
				})
			} catch (error) {
				if (error instanceof AccountDeletionInProgressError) {
					return fail('email-unavailable', 'account_deleting')
				}
				if (getUniqueConstraintField(error)) {
					return fail('connection-conflict', 'connection_conflict')
				}
				throw error
			}
			await completeDiscordGuildLogin({
				provider,
				userId: currentUser.id,
				discordUserId: profile.providerUserId,
				accessToken,
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'oauth_connection_linked',
				result: 'success',
				email: currentUser.email,
				ip: requestIp,
				path: url.pathname,
				reason: `provider=${provider}`,
			})
			return redirect(
				signedInOauthReturnLocation(redirectTo, 'oauthLinked', provider),
				[clearStateCookie],
			)
		}

		// 2. A known connection signs its user in directly.
		if (connection) {
			const user = await db.findOne(usersTable, {
				where: { id: connection.user_id },
			})
			if (!user || user.deleted_at) {
				return fail('account-error', 'connection_user_missing')
			}
			await completeDiscordGuildLogin({
				provider,
				userId: user.id,
				discordUserId: profile.providerUserId,
				accessToken,
			})
			return issueLogin(user)
		}

		// Without a provider-verified email we can neither match an
		// existing account nor create one safely.
		if (!profile.email || !profile.emailVerified) {
			return fail('no-verified-email', 'no_verified_email')
		}
		const email = normalizeEmail(profile.email)

		// 3. A provider-verified email matching an existing account links
		// the identity and signs that account in. An unverified row is
		// treated as a possible squat: invalidate the password, drop
		// attacker-added factors, then link.
		const existingUser = await db.findOne(usersTable, { where: { email } })
		if (existingUser) {
			try {
				await assertAccountWritableDb(
					env.APP_DB,
					personalOrgId(personIdFromStored(existingUser.stable_user_id)),
				)
			} catch (error) {
				if (error instanceof AccountDeletionInProgressError) {
					return fail('email-unavailable', 'account_deleting')
				}
				throw error
			}
			let sessionIssuedAt: number | undefined
			if (!existingUser.email_verified_at) {
				const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthGrantHelpers })
					.OAUTH_PROVIDER
				try {
					const reclaim = await applyPasswordChange({
						db,
						d1: env.APP_DB,
						helpers,
						userId: existingUser.id,
						stableUserId: personalOrgId(
							personIdFromStored(existingUser.stable_user_id),
						),
						unusablePasswordHash: unusablePasswordHash.reclaimedUnverified,
						clearSecondFactorsAndConnections: true,
						requireWritableAccount: true,
					})
					if (!reclaim.ok) {
						return fail(
							'account-error',
							reclaim.reason === 'oauth_grant_revoke_failed'
								? reclaim.detail
								: reclaim.reason,
						)
					}
					sessionIssuedAt = reclaim.changedAtMs + 1
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'social_link_reclaimed_unverified_account',
						result: 'success',
						email: existingUser.email,
						ip: requestIp,
						path: url.pathname,
						reason: `provider=${provider};${clearedFactorsAuditReason(reclaim.cleared ?? { twoFactorRows: 0, passkeys: 0, oauthConnections: 0 })}`,
					})
				} catch (error) {
					if (error instanceof AccountDeletionInProgressError) {
						return fail('email-unavailable', 'account_deleting')
					}
					throw error
				}
			}
			try {
				await createConnection({
					provider,
					profile,
					userId: existingUser.id,
				})
			} catch (error) {
				if (error instanceof AccountDeletionInProgressError) {
					return fail('email-unavailable', 'account_deleting')
				}
				if (getUniqueConstraintField(error)) {
					return fail('connection-conflict', 'connection_conflict')
				}
				throw error
			}
			// The provider asserted ownership of this exact email, which is
			// the same proof the verification email flow provides.
			if (!existingUser.email_verified_at) {
				const stamped = await env.APP_DB.prepare(
					`UPDATE users
						 SET email_verified_at = ?, updated_at = CURRENT_TIMESTAMP
						 WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
				)
					.bind(new Date().toISOString(), existingUser.id)
					.run()
				if ((stamped.meta.changes ?? 0) === 1) {
					recordOnboardingFunnelEvent(env, {
						stage: 'email_verified',
						userId: personalOrgId(
							personIdFromStored(existingUser.stable_user_id),
						),
					})
				}
				if ((stamped.meta.changes ?? 0) !== 1) {
					await env.APP_DB.prepare(
						`DELETE FROM oauth_connections
							 WHERE user_id = ? AND provider_name = ? AND provider_id = ?`,
					)
						.bind(existingUser.id, provider, profile.providerUserId)
						.run()
					return fail('email-unavailable', 'account_deleting')
				}
			}
			await completeDiscordGuildLogin({
				provider,
				userId: existingUser.id,
				discordUserId: profile.providerUserId,
				accessToken,
			})
			return issueLogin(existingUser, '/account', {
				issuedAt: sessionIssuedAt,
			})
		}

		// 4. New account. Reject addresses we would not store before any
		// identity allocation or user-row write.
		const emailDecision = await assessAccountEmail(email, {
			allowExampleDomain: isNonProductionRuntime(env),
		})
		if (!emailDecision.ok) {
			return fail(
				oauthCodeForAccountEmail(emailDecision.code),
				emailDecision.code,
			)
		}

		let username: string
		let stableUserId: OwnerId
		let signupPersonalOrgId: OwnerId
		let newUser: {
			id: number
			stable_user_id: string
			email: string
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
			username = await getAvailableUsernameFromBase(
				env.APP_DB,
				profile.username ?? usernameFromEmail(email),
				env,
			)
			const allocated = await allocateSignupIdentity(env.APP_DB, email)
			if (!allocated.ok) {
				if (allocated.reason === 'former_email_claimed') {
					return fail('email-claimed', 'former_email_claimed')
				}
				return fail('account-error', 'user_create_conflict')
			}
			stableUserId = personalOrgId(allocated.stableUserId)
			signupPersonalOrgId = mintPersonalOrgIdForSignup()
			recordOnboardingFunnelEvent(env, {
				stage: 'signup_started',
				userId: stableUserId,
			})
			const createdAt = new Date().toISOString()
			const signupAttribution = loginState.attribution
			const createdUser = await db.create(
				usersTable,
				{
					username,
					email,
					stable_user_id: stableUserId,
					personal_org_id: signupPersonalOrgId,
					password_hash: oauthNoUsablePasswordHash,
					email_verified_at: createdAt,
					...firstTouchAttributionCreateFields(signupAttribution),
					last_active_at: createdAt,
				},
				{ returnRow: true },
			)
			newUser = { id: createdUser.id, stable_user_id: stableUserId, email }
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
			if (
				uniqueField === 'stable_user_id' ||
				uniqueField === 'personal_org_id'
			) {
				return fail('email-claimed', 'former_email_claimed')
			}
			if (uniqueField) {
				return fail('account-error', 'user_create_conflict')
			}
			throw error
		}

		if (!newUser) {
			return fail('account-error', 'user_create_conflict')
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
			return fail('account-error', 'default_role_assignment_failed')
		}

		try {
			await claimAccountEmail(env.APP_DB, {
				userId: newUser.id,
				email,
			})
		} catch (error) {
			console.error('Failed to claim OAuth signup email:', error)
			await rollbackNewUser(newUser.id)
			return fail('account-error', 'email_claim_failed')
		}

		try {
			await createConnection({ provider, profile, userId: newUser.id })
		} catch (error) {
			console.error('Failed to store OAuth connection at signup:', error)
			await rollbackNewUser(newUser.id)
			return fail('account-error', 'connection_create_failed')
		}
		await completeDiscordGuildLogin({
			provider,
			userId: newUser.id,
			discordUserId: profile.providerUserId,
			accessToken,
		})

		// Best-effort, mirroring password signup: the automatic
		// {username}@<platform domain> inbox is also provisioned on first
		// inbound mail, so a failure here must not fail the signup.
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

		// Best-effort: if this email is already in Kit,
		// add signed_up::kody without removing other tags.
		await maybeTagKitSubscriberOnSignup({
			env,
			email,
		})
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
			attribution: loginState.attribution,
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
					searchParams: url.searchParams,
					cookieHeader: request.headers.get('Cookie'),
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
			ip: requestIp,
			path: url.pathname,
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
		return issueLogin(newUser, defaultPostVerificationRedirect, {
			destination: withAccountCreatedQuery(
				redirectTo ?? defaultPostVerificationRedirect,
			),
			clearReferralCookie: true,
		})
	}
}

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
import {
	destroyOauthLoginStateCookie,
	readOauthLoginState,
	setOauthLoginStateSecret,
} from '#app/oauth-login-state.ts'
import {
	createOauthPendingSignupCookie,
	setOauthPendingSignupSecret,
} from '#app/oauth-pending-signup.ts'
import {
	generateOauthRandomValue,
	getOauthClientConfig,
	isOauthProviderId,
	resolveOauthProfile,
	type OauthProfile,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { type OauthLoginErrorCode } from '#universal/oauth-login-errors.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import {
	assessAccountEmail,
	type AccountEmailRejectionCode,
} from '#worker/identity/account-email-policy.ts'
import { serializeReferralCookie } from '#universal/referral-cookie.ts'
import { routes } from '#universal/routes.ts'
import { resolvePostAuthLandingPath } from '#universal/safe-redirect.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritableDb,
} from '#worker/account/deletion-state.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createDb, oauthConnectionsTable, usersTable } from '#worker/db.ts'
import {
	maybeJoinOfficialDiscordGuild,
	maybeSyncDiscordGuildRolesForUser,
} from '#worker/discord/guild-role.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import { findActiveEmailClaim } from '#worker/identity/email-claims.ts'
import {
	findSoftDeletedAccountById,
	releaseSoftDeletedAccounts,
	releaseSoftDeletedAccountsForEmail,
} from '#worker/identity/deleted-account-identity-release.ts'
import { getAvailableUsernameFromBase } from '#worker/identity/generated-username.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { getCallbackRedirectUri } from '#worker/identity/oauth-provider-redirect.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { usernameFromEmail } from '#worker/identity/username.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import {
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

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

		let connection = await db.findOne(oauthConnectionsTable, {
			where: {
				provider_name: provider,
				provider_id: profile.providerUserId,
			},
		})
		// Signed out, the same provider identity proves the person behind a
		// deleted account; release it so this sign-in starts a fresh account.
		// Signed-in linking never supersedes (it stays a connection conflict).
		const supersededAccount =
			connection && !session
				? await findSoftDeletedAccountById(env.APP_DB, connection.user_id)
				: null
		const releasedUsernames: Array<string> = []
		if (supersededAccount) connection = null

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
		if (supersededAccount) {
			const released = await releaseSoftDeletedAccounts(env.APP_DB, [
				supersededAccount,
			])
			releasedUsernames.push(...released.releasedUsernames)
		}
		const releasedForEmail = await releaseSoftDeletedAccountsForEmail(
			env.APP_DB,
			email,
		)
		releasedUsernames.push(...releasedForEmail.releasedUsernames)

		// 3. A provider-verified email matching an existing account links
		// the identity and signs that account in. An unverified row is
		// treated as a possible squat: invalidate the password, drop
		// attacker-added factors, then link.
		const existingUser = await db.findOne(usersTable, { where: { email } })
		if (existingUser && !existingUser.deleted_at) {
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

		// 4. New account. Reject addresses we would not store, then park the
		// verified provider identity so the person chooses a permanent
		// username before any user row is written.
		const emailDecision = await assessAccountEmail(email, {
			allowExampleDomain: isNonProductionRuntime(env),
		})
		if (!emailDecision.ok) {
			return fail(
				oauthCodeForAccountEmail(emailDecision.code),
				emailDecision.code,
			)
		}
		// Former-email claims block new accounts; fail before parking pending
		// so the person never reaches the username chooser for a dead end.
		if (await findActiveEmailClaim(env.APP_DB, email)) {
			return fail('email-claimed', 'former_email_claimed')
		}

		const suggestedUsername = await getAvailableUsernameFromBase(
			env.APP_DB,
			releasedUsernames[0] ?? profile.username ?? usernameFromEmail(email),
			env,
		)
		setOauthPendingSignupSecret(env.COOKIE_SECRET)
		const pendingCookie = await createOauthPendingSignupCookie(
			{
				provider,
				providerUserId: profile.providerUserId,
				email,
				providerUsername: profile.username,
				displayName: profile.displayName,
				suggestedUsername,
				redirectTo,
				attribution: loginState.attribution,
				csrf: generateOauthRandomValue(),
				accessToken,
				issuedAt: Date.now(),
			},
			secure,
		)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'oauth_signup_pending',
			result: 'success',
			email,
			ip: requestIp,
			path: url.pathname,
			reason: `provider=${provider}`,
		})
		// The query copy only rebuilds a restart link if the cookie expires;
		// completion always reads the signed cookie's redirectTo.
		const chooseUsernamePath = redirectTo
			? `/signup/choose-username?${new URLSearchParams({ redirectTo })}`
			: '/signup/choose-username'
		return redirect(chooseUsernamePath, [pendingCookie, clearStateCookie])
	}
}

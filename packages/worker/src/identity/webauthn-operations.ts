import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { authOperationResult } from './auth-operation-result.ts'
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	createAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { buildDefaultPasskeyName } from '#app/passkey-label.ts'
import {
	createPasskey,
	findPasskeyById,
	listPasskeysForUser,
	updatePasskeyCounter,
} from '#app/passkeys.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import {
	createWebAuthnChallengeCookie,
	destroyWebAuthnChallengeCookie,
	getWebAuthnConfig,
	readWebAuthnChallenge,
	setWebAuthnChallengeSecret,
} from '#app/webauthn.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

export async function webauthnRegistrationOptions({
	env,
	request,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
}) {
	setWebAuthnChallengeSecret(env.COOKIE_SECRET)
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return authOperationResult({ ok: false, error: 'Unauthorized.' }, 401)
	}

	const config = getWebAuthnConfig(request)
	const secure = isSecureRequest(request)

	const existingPasskeys = await listPasskeysForUser(env.APP_DB, user.userId)
	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpID,
		userName: user.username,
		userID: new TextEncoder().encode(user.mcpUser.userId),
		userDisplayName: user.displayName || user.email,
		attestationType: 'none',
		excludeCredentials: existingPasskeys.map((passkey) => ({
			id: passkey.id,
		})),
		// Passkeys are MFA-complete here, so user verification is required
		// end-to-end (matching requireUserVerification below; `preferred`
		// could register credentials the server then rejects).
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'required',
		},
	})

	return authOperationResult(
		{ ok: true, options },
		{
			headers: {
				'Set-Cookie': await createWebAuthnChallengeCookie(
					{
						challenge: options.challenge,
						webauthnUserId: options.user.id,
						stableUserId: user.mcpUser.userId,
					},
					secure,
				),
			},
		},
	)
}

export async function webauthnRegistrationVerify({
	env,
	request,
	url,
	body,
}: {
	env: Env
	request: Request
	url: URL
	body: { response?: RegistrationResponseJSON; rememberMe?: unknown }
}) {
	setWebAuthnChallengeSecret(env.COOKIE_SECRET)
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return authOperationResult({ ok: false, error: 'Unauthorized.' }, 401)
	}

	const config = getWebAuthnConfig(request)
	const secure = isSecureRequest(request)

	const requestIp = getRequestIp(request) ?? undefined
	const challengeData = await readWebAuthnChallenge(request)
	const clearChallengeCookie = await destroyWebAuthnChallengeCookie(secure)
	// The ceremony must complete for the same user it started for, so a
	// session swap between GET and POST can't bind the credential to the
	// wrong account.
	if (
		!challengeData?.webauthnUserId ||
		challengeData.stableUserId !== user.mcpUser.userId
	) {
		return authOperationResult(
			{
				ok: false,
				error: 'Registration session expired. Please try again.',
			},
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	if (!body?.response || typeof body.response !== 'object') {
		return authOperationResult(
			{ ok: false, error: 'Invalid registration response.' },
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
	try {
		verification = await verifyRegistrationResponse({
			response: body.response,
			expectedChallenge: challengeData.challenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpID,
			requireUserVerification: true,
		})
	} catch (error) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'passkey_register',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'verification_error',
		})
		console.warn('Passkey registration verification failed:', error)
		return authOperationResult(
			{ ok: false, error: 'Passkey registration failed.' },
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	if (!verification.verified || !verification.registrationInfo) {
		return authOperationResult(
			{ ok: false, error: 'Passkey registration failed.' },
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
		verification.registrationInfo

	const existingPasskey = await findPasskeyById(env.APP_DB, credential.id)
	if (existingPasskey) {
		return authOperationResult(
			{ ok: false, error: 'This passkey is already registered.' },
			{ status: 409, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	await createPasskey(env.APP_DB, {
		id: credential.id,
		aaguid,
		publicKey: isoBase64URL.fromBuffer(credential.publicKey),
		userId: user.userId,
		webauthnUserId: challengeData.webauthnUserId,
		counter: credential.counter,
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp,
		transports: credential.transports?.join(',') ?? null,
		name: buildDefaultPasskeyName({
			aaguid,
			deviceType: credentialDeviceType,
			userAgent: request.headers.get('user-agent'),
		}),
	})

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'passkey_register',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: url.pathname,
	})
	return authOperationResult(
		{ ok: true },
		{ headers: { 'Set-Cookie': clearChallengeCookie } },
	)
}

export async function webauthnAuthenticationOptions({
	env,
	request,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
}) {
	setWebAuthnChallengeSecret(env.COOKIE_SECRET)
	setAuthSessionSecret(env.COOKIE_SECRET)

	const config = getWebAuthnConfig(request)
	const secure = isSecureRequest(request)

	const options = await generateAuthenticationOptions({
		rpID: config.rpID,
		userVerification: 'required',
	})
	return authOperationResult(
		{ ok: true, options },
		{
			headers: {
				'Set-Cookie': await createWebAuthnChallengeCookie(
					{ challenge: options.challenge },
					secure,
				),
			},
		},
	)
}

export async function webauthnAuthenticationVerify({
	env,
	request,
	url,
	body,
}: {
	env: Env
	request: Request
	url: URL
	body: { response?: AuthenticationResponseJSON; rememberMe?: unknown }
}) {
	const db = createDb(env.APP_DB)
	setWebAuthnChallengeSecret(env.COOKIE_SECRET)
	setAuthSessionSecret(env.COOKIE_SECRET)

	const config = getWebAuthnConfig(request)
	const secure = isSecureRequest(request)

	const requestIp = getRequestIp(request) ?? undefined
	const challengeData = await readWebAuthnChallenge(request)
	const clearChallengeCookie = await destroyWebAuthnChallengeCookie(secure)
	if (!challengeData) {
		return authOperationResult(
			{ ok: false, error: 'Sign-in session expired. Please try again.' },
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	if (!body?.response || typeof body.response !== 'object') {
		return authOperationResult(
			{ ok: false, error: 'Invalid authentication response.' },
			{ status: 400, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}
	const rememberMe = body.rememberMe === true

	const passkey = await findPasskeyById(env.APP_DB, body.response.id)
	if (!passkey) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'passkey_login',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'unknown_passkey',
		})
		return authOperationResult(
			{ ok: false, error: 'Passkey not recognized.' },
			{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
	try {
		verification = await verifyAuthenticationResponse({
			response: body.response,
			expectedChallenge: challengeData.challenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpID,
			credential: {
				id: passkey.id,
				publicKey: isoBase64URL.toBuffer(passkey.public_key),
				counter: passkey.counter,
			},
			requireUserVerification: true,
		})
	} catch (error) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'passkey_login',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'verification_error',
		})
		console.warn('Passkey authentication verification failed:', error)
		return authOperationResult(
			{ ok: false, error: 'Passkey sign-in failed.' },
			{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	if (!verification.verified) {
		return authOperationResult(
			{ ok: false, error: 'Passkey sign-in failed.' },
			{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	await updatePasskeyCounter(
		env.APP_DB,
		passkey.id,
		verification.authenticationInfo.newCounter,
	)

	const userRecord = await db.findOne(usersTable, {
		where: { id: passkey.user_id },
	})
	if (!userRecord || userRecord.deleted_at) {
		return authOperationResult(
			{ ok: false, error: 'Passkey sign-in failed.' },
			{ status: 401, headers: { 'Set-Cookie': clearChallengeCookie } },
		)
	}

	const headers = new Headers({
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
	})
	headers.append('Set-Cookie', clearChallengeCookie)

	// A verified passkey assertion already satisfies MFA (possession +
	// user verification), so skip the TOTP challenge even when 2FA is
	// enabled. Password and social logins still require it.
	const stableUserId = personIdFromStored(userRecord.stable_user_id)
	headers.append(
		'Set-Cookie',
		await createAuthCookie(
			{
				stableUserId,
				email: userRecord.email,
				rememberMe,
			},
			secure,
		),
	)
	await touchLastActiveAt(env.APP_DB, {
		stableUserId,
	})
	await reconcileSignupWelcomeCreditsIfPending({
		db: env.APP_DB,
		userId: personalOrgIdFromUserRow(userRecord),
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'passkey_login',
		result: 'success',
		email: userRecord.email,
		ip: requestIp,
		path: url.pathname,
	})
	return authOperationResult(
		{ ok: true },
		{
			status: 200,
			headers,
		},
	)
}

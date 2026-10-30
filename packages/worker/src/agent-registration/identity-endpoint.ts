import { McpCallerError } from '#mcp/caller-error.ts'
import { cliCredentialBootstrapDefaultScopes } from '#worker/api-tokens/cli-credential-bootstrap.ts'
import { resolveApiTokenLifetime } from '#worker/api-tokens/service.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { formatUserCode } from '#worker/oauth-device/device-grant.ts'
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import {
	agentClaimAttemptTtlSeconds,
	agentClaimPollIntervalSeconds,
	createClaimAttempt,
	findAgentRegistrationByClaimTokenHash,
	generateClaimToken,
	hashAgentRegistrationSecret,
	insertAgentRegistration,
	nowSeconds,
	purgeExpiredAgentRegistrations,
	replaceClaimAttempt,
	type AgentClaimAttempt,
} from './store.ts'

/** Registrations per IP. A person connecting one agent needs one or two. */
export const agentIdentityIpRateLimit: RateLimitConfig = {
	maxRequests: 20,
	windowSeconds: 60 * 60,
}

/** Registrations per `login_hint`, so one address cannot be flooded. */
export const agentIdentityEmailRateLimit: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 60 * 60,
}

/** Fresh claim attempts per IP on `/agent/identity/claim`. */
export const agentClaimRestartRateLimit: RateLimitConfig = {
	maxRequests: 20,
	windowSeconds: 60 * 60,
}

/** Default lifetime when the agent sends none (ADR 0091 amends 0056). */
export const agentRegistrationDefaultLifetime = 'long'

function agentError(error: string, description: string, status = 400) {
	return jsonResponse(
		{ error, error_description: description },
		{
			status,
			headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
		},
	)
}

function methodNotAllowed() {
	return new Response('Method not allowed', {
		status: 405,
		headers: { Allow: 'POST' },
	})
}

async function readJsonObject(request: Request) {
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/json')) return null
	const body = (await request.json().catch(() => null)) as unknown
	return body && typeof body === 'object' && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null
}

/** The bare address, lowercased, or null for anything else. */
export function readLoginHintEmail(value: unknown) {
	if (typeof value !== 'string') return null
	const normalized = normalizeEmailAddress(value)
	return normalized && normalized === value.trim().toLowerCase()
		? normalized
		: null
}

function optionalNumber(value: unknown) {
	return typeof value === 'number' ? value : undefined
}

function claimBlock(appOrigin: string, attempt: AgentClaimAttempt) {
	const verificationUri = new URL(oauthPaths.agentClaim, appOrigin)
	verificationUri.searchParams.set('claim_attempt_token', attempt.attemptToken)
	return {
		user_code: formatUserCode(attempt.userCode),
		expires_in: agentClaimAttemptTtlSeconds,
		verification_uri: verificationUri.href,
		interval: agentClaimPollIntervalSeconds,
	}
}

async function rateLimited(
	env: Env,
	key: string,
	config: RateLimitConfig,
): Promise<Response | null> {
	const limit = await checkRateLimit(env.APP_DB, key, config)
	if (limit.allowed) return null
	return agentError(
		'rate_limited',
		'Too many agent registration requests. Back off and try again later.',
		429,
	)
}

/** `POST /agent/identity` (auth.md registration, `service_auth` only). */
export async function handleAgentIdentityRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') return methodNotAllowed()
	const ip = getRequestIp(request) ?? 'unknown'
	const ipLimited = await rateLimited(
		env,
		`agent-identity:ip:${ip}`,
		agentIdentityIpRateLimit,
	)
	if (ipLimited) return ipLimited
	const body = await readJsonObject(request)
	if (!body) {
		return agentError(
			'invalid_request',
			'Send a JSON object with Content-Type: application/json.',
		)
	}
	if (body.type === 'anonymous') {
		return agentError(
			'anonymous_not_enabled',
			'Kody does not accept anonymous registration. Use service_auth with the person’s email as login_hint.',
		)
	}
	if (body.type === 'identity_assertion') {
		return agentError(
			'issuer_not_enabled',
			'Kody does not trust any identity assertion issuers yet. Use service_auth with the person’s email as login_hint.',
		)
	}
	if (body.type !== 'service_auth') {
		return agentError('invalid_request', 'type must be "service_auth".')
	}
	const claimEmail = readLoginHintEmail(body.login_hint)
	if (!claimEmail) {
		return agentError(
			'invalid_login_hint',
			'login_hint must be the email address of the person you are acting for.',
		)
	}
	const emailLimited = await rateLimited(
		env,
		`agent-identity:email:${await hashAgentRegistrationSecret(claimEmail)}`,
		agentIdentityEmailRateLimit,
	)
	if (emailLimited) return emailLimited
	const idleTtlSeconds = optionalNumber(body.idle_ttl_seconds)
	const maxLifetimeSeconds = optionalNumber(body.max_lifetime_seconds)
	const lifetimeInput =
		typeof body.lifetime === 'string'
			? body.lifetime
			: idleTtlSeconds === undefined && maxLifetimeSeconds === undefined
				? agentRegistrationDefaultLifetime
				: undefined
	let lifetime: ReturnType<typeof resolveApiTokenLifetime>
	try {
		lifetime = resolveApiTokenLifetime({
			lifetime: lifetimeInput,
			idleTtlSeconds,
			maxLifetimeSeconds,
		})
	} catch (error) {
		if (error instanceof McpCallerError) {
			return agentError('invalid_request', error.message)
		}
		throw error
	}

	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	const now = nowSeconds()
	await purgeExpiredAgentRegistrations(env.APP_DB, now)
	const id = crypto.randomUUID()
	const claimToken = generateClaimToken()
	const attempt = await createClaimAttempt(now)
	await insertAgentRegistration(env.APP_DB, {
		id,
		claimTokenHash: await hashAgentRegistrationSecret(claimToken),
		claimEmail,
		attempt,
		idleTtlSeconds: lifetime.idleTtlSeconds,
		maxLifetimeSeconds: lifetime.maxLifetimeSeconds,
		now,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'agent_registration',
		result: 'success',
		email: claimEmail,
		ip,
	})
	const row = await findAgentRegistrationByClaimTokenHash(
		env.APP_DB,
		await hashAgentRegistrationSecret(claimToken),
	)
	return jsonResponse(
		{
			registration_id: id,
			registration_type: 'service_auth',
			claim_url: new URL(oauthPaths.agentIdentityClaim, appOrigin).href,
			claim_token: claimToken,
			claim_token_expires: new Date(
				(row?.expires_at ?? now) * 1000,
			).toISOString(),
			post_claim_scopes: [...cliCredentialBootstrapDefaultScopes],
			claim: claimBlock(appOrigin, attempt),
		},
		{ headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
	)
}

/** `POST /agent/identity/claim`: a fresh claim attempt for the same email. */
export async function handleAgentClaimRestartRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') return methodNotAllowed()
	const ip = getRequestIp(request) ?? 'unknown'
	const limited = await rateLimited(
		env,
		`agent-identity:claim:ip:${ip}`,
		agentClaimRestartRateLimit,
	)
	if (limited) return limited
	const body = await readJsonObject(request)
	const claimToken =
		typeof body?.claim_token === 'string' ? body.claim_token : null
	if (!body || !claimToken) {
		return agentError('invalid_request', 'claim_token and email are required.')
	}
	const row = await findAgentRegistrationByClaimTokenHash(
		env.APP_DB,
		await hashAgentRegistrationSecret(claimToken),
	)
	const now = nowSeconds()
	if (!row) {
		return agentError(
			'invalid_claim_token',
			'Unknown claim_token. Register again at /agent/identity.',
		)
	}
	if (row.expires_at <= now) {
		return agentError(
			'claim_expired',
			'This registration expired. Register again at /agent/identity.',
			410,
		)
	}
	if (row.status !== 'pending') {
		return agentError(
			'claimed_or_in_flight',
			'This registration is no longer waiting for a claim. Poll /oauth/token, or register again.',
		)
	}
	if (readLoginHintEmail(body.email) !== row.claim_email) {
		return agentError(
			'invalid_request',
			'email must match the login_hint sent at registration.',
		)
	}
	const attempt = await createClaimAttempt(now)
	const replaced = await replaceClaimAttempt(env.APP_DB, row.id, attempt, now)
	if (!replaced) {
		return agentError(
			'claimed_or_in_flight',
			'This registration is no longer waiting for a claim. Poll /oauth/token, or register again.',
		)
	}
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	return jsonResponse(
		{
			registration_id: row.id,
			claim_attempt_id: attempt.attemptId,
			status: 'initiated',
			expires_at: new Date(attempt.attemptExpiresAt * 1000).toISOString(),
			claim_attempt: claimBlock(appOrigin, attempt),
		},
		{ headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
	)
}

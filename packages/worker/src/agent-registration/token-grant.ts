import * as Sentry from '@sentry/cloudflare'
import { cliCredentialBootstrapDefaultScopes } from '#worker/api-tokens/cli-credential-bootstrap.ts'
import { mintApiToken } from '#worker/api-tokens/service.ts'
import { loadLiveOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	oauthErrorResponse,
	readFormValue,
} from '#worker/oauth-device/oauth-errors.ts'
import {
	consumeClaimedAgentRegistration,
	findAgentRegistrationByClaimTokenHash,
	hashAgentRegistrationSecret,
	nowSeconds,
	recordAgentClaimPoll,
	restoreClaimedAgentRegistration,
} from './store.ts'

export const agentRegistrationTokenName = 'kody-agent'

/**
 * `POST /oauth/token` with `grant_type=urn:workos:agent-auth:grant-type:claim`
 * (auth.md claim poll). Success is a standard token response whose
 * `access_token` is a user-owned `kody_at_`. There is no refresh token and no
 * identity assertion (ADR 0091): the agent registers again when it expires.
 */
export async function handleAgentClaimTokenRequest(input: {
	request: Request
	env: Env
	form: FormData
}): Promise<Response> {
	const { env, form } = input
	const claimToken = readFormValue(form, 'claim_token')
	if (!claimToken) {
		return oauthErrorResponse('invalid_request', 'claim_token is required.')
	}
	const row = await findAgentRegistrationByClaimTokenHash(
		env.APP_DB,
		await hashAgentRegistrationSecret(claimToken),
	)
	const now = nowSeconds()
	if (!row || row.expires_at <= now) {
		return oauthErrorResponse(
			'expired_token',
			'This registration is unknown or expired. Register again at /agent/identity.',
		)
	}
	if (row.status === 'consumed') {
		return oauthErrorResponse(
			'invalid_grant',
			'This registration already issued its token. Register again for a new one.',
		)
	}
	if (row.status === 'denied') {
		return oauthErrorResponse(
			'access_denied',
			'The person denied this registration.',
		)
	}
	if (row.status === 'pending') {
		const pace = await recordAgentClaimPoll(env.APP_DB, row, now)
		if (pace.tooFast) {
			return oauthErrorResponse(
				'slow_down',
				'Polling too fast. Wait longer between polls.',
				400,
				{ interval: pace.intervalSeconds },
			)
		}
		if (row.attempt_expires_at <= now) {
			return oauthErrorResponse(
				'expired_token',
				'The user code expired. Call /agent/identity/claim with the same claim_token and email for a fresh code.',
			)
		}
		return oauthErrorResponse(
			'authorization_pending',
			'The person has not completed the claim yet.',
		)
	}
	if (!row.user_id || !row.org_id) {
		return oauthErrorResponse('invalid_grant', 'This claim is incomplete.')
	}
	if (!(await loadLiveOrgBindingForOrg(env.APP_DB, row.user_id, row.org_id))) {
		return oauthErrorResponse(
			'access_denied',
			'The person no longer has access to the selected organization.',
		)
	}
	const consumed = await consumeClaimedAgentRegistration(
		env.APP_DB,
		row.id,
		now,
	)
	if (!consumed) {
		return oauthErrorResponse(
			'invalid_grant',
			'This registration already issued its token. Register again for a new one.',
		)
	}
	let minted: Awaited<ReturnType<typeof mintApiToken>>
	try {
		minted = await mintApiToken({
			db: env.APP_DB,
			userId: row.user_id,
			orgId: row.org_id,
			orgBinding: 'org',
			name: agentRegistrationTokenName,
			scopes: cliCredentialBootstrapDefaultScopes,
			idleTtlSeconds: row.idle_ttl_seconds,
			maxLifetimeSeconds: row.max_lifetime_seconds,
			createdVia: 'agent-registration',
		})
	} catch (error) {
		Sentry.captureException(error)
		await restoreClaimedAgentRegistration(env.APP_DB, row.id)
		return oauthErrorResponse(
			'server_error',
			'Kody could not issue the token. Poll again shortly.',
			500,
		)
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'agent_registration_token',
		result: 'success',
		ip: getRequestIp(input.request) ?? undefined,
	})
	const expiresIn = Math.max(
		0,
		Math.floor((Date.parse(minted.expires_at) - Date.now()) / 1000),
	)
	return jsonResponse(
		{
			access_token: minted.token,
			token_type: 'Bearer',
			expires_in: expiresIn,
			scope: minted.scopes.join(' '),
		},
		{ headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
	)
}

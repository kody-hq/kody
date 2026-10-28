import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { connectionProfileGrantFields } from '#worker/connection-profiles/oauth.ts'
import { createDb, usersTable } from '#worker/db.ts'
import {
	getUsernameFormatValidationError,
	resolveStoredDisplayName,
} from '#worker/identity/username.ts'
import { pruneUserClientOAuthGrants } from '#worker/oauth-grant-prune.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { grantBindingFields } from '#worker/orgs/oauth-grant.ts'
import { cliOAuthCallbackUrl } from '#worker/cli-client-metadata.ts'
import { createServerPkcePair } from './device-grant.ts'
import { type DeviceAuthorizationRow } from './store.ts'

type GrantHelpers = {
	completeAuthorization: (options: {
		request: AuthRequest
		userId: string
		metadata: Record<string, unknown>
		scope: Array<string>
		props: Record<string, unknown>
		revokeExistingGrants?: boolean
	}) => Promise<{ redirectTo: string }>
	listUserGrants: (...args: Array<never>) => Promise<unknown>
	revokeGrant: (...args: Array<never>) => Promise<unknown>
}

export class DeviceGrantMintError extends Error {}

/**
 * Turns a consumed device approval into the same provider grant a browser
 * `kody login` gets: `completeAuthorization` with the approver's props and org
 * binding, then the authorization code is redeemed against the provider's own
 * token endpoint with a server-held PKCE verifier. The device never sees the
 * code; it gets the provider's token response.
 */
export async function mintDeviceGrantTokens(input: {
	request: Request
	env: Env
	row: DeviceAuthorizationRow
	fetchProvider: (request: Request) => Promise<Response>
}): Promise<Request> {
	const { row, env } = input
	if (!row.user_id || !row.org_id) {
		throw new DeviceGrantMintError('Approved device request has no binding.')
	}
	const user = await createDb(env.APP_DB).findOne(usersTable, {
		where: { stable_user_id: row.user_id },
	})
	const username =
		typeof user?.username === 'string' &&
		!getUsernameFormatValidationError(user.username.trim())
			? user.username.trim()
			: null
	if (!user || user.deleted_at || !username) {
		throw new DeviceGrantMintError('The approving account is not available.')
	}
	const userId = personIdFromStored(user.stable_user_id)
	const email = user.email.trim().toLowerCase()
	const helpers = (await resolveOAuthHelpers<GrantHelpers>(env, {
		requestUrl: input.request.url,
	})) as GrantHelpers | undefined
	if (!helpers) throw new DeviceGrantMintError('OAuth storage is unavailable.')

	const pkce = await createServerPkcePair()
	const scope = row.scope.split(' ').filter(Boolean)
	const profileFields = connectionProfileGrantFields(null)
	const bindingFields = grantBindingFields({
		orgId: row.org_id,
		personId: userId,
	})
	const { redirectTo } = await helpers.completeAuthorization({
		request: {
			responseType: 'code',
			clientId: row.client_id,
			redirectUri: cliOAuthCallbackUrl,
			scope,
			state: '',
			codeChallenge: pkce.challenge,
			codeChallengeMethod: 'S256',
			resource: row.resource,
		} as AuthRequest,
		userId,
		metadata: {
			email,
			clientId: row.client_id,
			grantedVia: 'device_code',
			...profileFields.metadata,
			...bindingFields.metadata,
		},
		scope,
		props: {
			userId,
			email,
			username,
			displayName: resolveStoredDisplayName(user.display_name, username),
			authTime: row.decided_at ?? Math.floor(Date.now() / 1000),
			...profileFields.props,
			...bindingFields.props,
		},
		revokeExistingGrants: false,
	})
	const code = new URL(redirectTo).searchParams.get('code')
	if (!code) throw new DeviceGrantMintError('Provider returned no code.')
	await pruneUserClientOAuthGrants({
		helpers: helpers as never,
		userId,
		clientId: row.client_id,
		env,
		email,
		ip: getRequestIp(input.request) ?? undefined,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'device_token',
		result: 'success',
		email,
		ip: getRequestIp(input.request) ?? undefined,
		clientId: row.client_id,
	})
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: cliOAuthCallbackUrl,
		client_id: row.client_id,
		code_verifier: pkce.verifier,
		resource: row.resource,
	})
	return new Request(input.request.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	})
}

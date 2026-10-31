import * as Sentry from '@sentry/cloudflare'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { deviceGrantUnauthorizedClientMessage } from './authorization-endpoint.ts'
import { mintDeviceGrantTokens } from './consume-grant.ts'
import { hashDeviceCode, isDeviceGrantClientAllowed } from './device-grant.ts'
import { oauthErrorResponse, readFormValue } from './oauth-errors.ts'
import {
	consumeApprovedDeviceAuthorization,
	findDeviceAuthorizationByDeviceCodeHash,
	nowSeconds,
	recordDevicePoll,
} from './store.ts'

/**
 * `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
 * (RFC 8628 section 3.4). Returns either an RFC 8628 error response or the
 * internal authorization_code request the caller must send through the
 * provider so the success path is the provider's own token response.
 */
export async function handleDeviceCodeTokenRequest(input: {
	request: Request
	env: Env
	form: FormData
	fetchProvider: (request: Request) => Promise<Response>
}): Promise<{ response: Response } | { providerRequest: Request }> {
	const { env, form } = input
	const appOrigin = getAppBaseUrl({ env, requestUrl: input.request.url })
	const clientId = readFormValue(form, 'client_id')
	const deviceCode = readFormValue(form, 'device_code')
	const ip = getRequestIp(input.request) ?? undefined
	if (!clientId || !deviceCode) {
		return {
			response: oauthErrorResponse(
				'invalid_request',
				'client_id and device_code are required.',
			),
		}
	}
	if (!isDeviceGrantClientAllowed(appOrigin, clientId)) {
		return {
			response: oauthErrorResponse(
				'unauthorized_client',
				deviceGrantUnauthorizedClientMessage,
			),
		}
	}
	const row = await findDeviceAuthorizationByDeviceCodeHash(
		env.APP_DB,
		await hashDeviceCode(deviceCode),
	)
	if (!row || row.client_id !== clientId || row.kind !== 'cli') {
		return {
			response: oauthErrorResponse(
				'invalid_grant',
				'Unknown device_code for this client.',
			),
		}
	}
	if (row.status === 'consumed') {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'device_token',
			result: 'failure',
			ip,
			clientId,
			reason: 'device_code_reused',
		})
		return {
			response: oauthErrorResponse(
				'invalid_grant',
				'This device_code was already used. Start a new sign-in.',
			),
		}
	}
	const now = nowSeconds()
	if (row.expires_at <= now) {
		return {
			response: oauthErrorResponse(
				'expired_token',
				'The sign-in code expired. Start a new sign-in.',
			),
		}
	}
	const poll = await recordDevicePoll(env.APP_DB, row, now)
	if (poll.tooFast) {
		return {
			response: oauthErrorResponse(
				'slow_down',
				`Polling too fast. Wait at least ${poll.intervalSeconds} seconds between requests.`,
				400,
				{ interval: poll.intervalSeconds },
			),
		}
	}
	if (row.status === 'denied') {
		return {
			response: oauthErrorResponse('access_denied', 'The sign-in was denied.'),
		}
	}
	if (row.status === 'pending') {
		return {
			response: oauthErrorResponse(
				'authorization_pending',
				'Waiting for the sign-in to be approved.',
			),
		}
	}
	if (!(await consumeApprovedDeviceAuthorization(env.APP_DB, row.id, now))) {
		return {
			response: oauthErrorResponse(
				'invalid_grant',
				'This device_code was already used. Start a new sign-in.',
			),
		}
	}
	try {
		return {
			providerRequest: await mintDeviceGrantTokens({
				request: input.request,
				env,
				row,
				fetchProvider: input.fetchProvider,
			}),
		}
	} catch (error) {
		Sentry.captureException(error)
		return {
			response: oauthErrorResponse(
				'invalid_grant',
				'The approved sign-in could not be completed. Start a new sign-in.',
			),
		}
	}
}

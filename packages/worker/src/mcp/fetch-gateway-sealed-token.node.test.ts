import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { buildSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import * as secretService from '#mcp/secrets/service.ts'
import {
	isActiveOrgQuery,
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { lookupSecretsThroughResolveSecret } from '#worker/test-support/secret-lookup.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const userMeter = createInMemoryUserMeterEnv()
const env = {
	APP_DB: {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
						async first() {
							if (isActiveOrgQuery(normalizedQuery)) return { ok: 1 }
							if (isOrgBindingMembershipQuery(normalizedQuery)) {
								return mockPersonalOrgBindingRow(String(params[1]), 'ada')
							}
							if (
								normalizedQuery.includes('where stable_user_id') &&
								params[0] !== 'user-123'
							) {
								throw new Error(
									'Account reverse-resolution must bind the acting userId.',
								)
							}
							return null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database,
	...userMeter.env,
	COOKIE_SECRET: 'test-cookie-secret',
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	// Opt out of credential-resolution audit writes (no AUDIT_DB in this
	// gateway fixture); see auditDatabaseFromEnv (#3456).
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

const props = {
	baseUrl: 'https://example.com',
	userId: ownerIdFromStored('user-123'),
	email: null,
	request: sessionRequestContext('user-123', 'ada'),
	storageContext: null,
}

function userSecret(
	value: string,
	allowedHosts: Array<string>,
	allowedPackages: Array<string> = [],
): secretService.ResolvedSecret {
	return {
		credentialId: `cred-${value}`,
		found: true,
		value,
		scope: 'user',
		allowedHosts,
		allowedPackages,
		placement: null,
	}
}

beforeEach(() => {
	lookupSecretsThroughResolveSecret()
})

test('fetch gateway seals token fields of a credential-filled response and fills them on egress', async () => {
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('client-secret-value', ['auth.example.com']),
	)
	const seen: Array<string | null> = []
	const globalFetch = vi.fn(async (outbound: Request) => {
		seen.push(outbound.headers.get('authorization'))
		return outbound.url.endsWith('/token')
			? Response.json({ access_token: 'minted', token_type: 'Bearer' })
			: Response.json({ echoed: outbound.headers.get('authorization') })
	}) as unknown as typeof fetch
	const runProps = { ...props, credentialClientBinding: 'run-a' }
	const send = (url: string, authorization: string, gatewayProps = runProps) =>
		executeGatewayFetch({
			env,
			props: gatewayProps,
			request: new Request(url, { headers: { Authorization: authorization } }),
			globalFetch,
		})
	const secret = buildSecretPlaceholder({ name: 'clientSecret', scope: null })
	const text = await (
		await send('https://auth.example.com/token', `Bearer ${secret}`)
	).text()
	expect(text).not.toContain('minted')
	const bearer = `Bearer ${String((JSON.parse(text) as Record<string, unknown>).access_token)}`
	// Filled on egress; the echo is redacted, not resealed.
	const echoed = await send('https://api.example.com/v1/me', bearer)
	expect(seen[1]).toBe('Bearer minted')
	expect(await echoed.text()).not.toContain('minted')
	await expect(
		send('https://api.example.com/v1/me', bearer, {
			...props,
			credentialClientBinding: 'run-b',
		}),
	).rejects.toThrow(/another run/)
	await expect(send('https://collector.test/x', bearer)).rejects.toThrow(
		/may only be sent to example\.com, not collector\.test/,
	)
	expect(seen).toHaveLength(2)
})

test('a token minted on a separate auth domain fills on the client secret approved hosts', async () => {
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('client-secret-value', [
			'login.example-auth.com',
			'api.example.org',
		]),
	)
	const seen: Array<string | null> = []
	const globalFetch = vi.fn(async (outbound: Request) => {
		seen.push(outbound.headers.get('authorization'))
		return outbound.url.endsWith('/token')
			? Response.json({ access_token: 'minted', token_type: 'Bearer' })
			: Response.json({ ok: true })
	}) as unknown as typeof fetch
	const send = (url: string, authorization: string) =>
		executeGatewayFetch({
			env,
			props: { ...props, credentialClientBinding: 'run-a' },
			request: new Request(url, { headers: { Authorization: authorization } }),
			globalFetch,
		})
	const secret = buildSecretPlaceholder({ name: 'clientSecret', scope: null })
	const token = (await (
		await send('https://login.example-auth.com/token', `Bearer ${secret}`)
	).json()) as Record<string, unknown>
	const bearer = `Bearer ${String(token.access_token)}`
	await send('https://api.example.org/v1/me', bearer)
	expect(seen[1]).toBe('Bearer minted')
	await expect(send('https://collector.test/x', bearer)).rejects.toThrow(
		/may only be sent to example-auth\.com, example\.org, not collector\.test/,
	)
	expect(seen).toHaveLength(2)
})

test('an Entra client-credentials token reaches its audience APIs with the secret approved only for login', async () => {
	vi.spyOn(secretService, 'resolveSecret').mockResolvedValue(
		userSecret('client-secret-value', ['login.microsoftonline.com']),
	)
	const jwt = (aud: string) =>
		`${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ aud })).toString('base64url')}.sig`
	const seen: Array<[string, string | null]> = []
	const globalFetch = vi.fn(async (outbound: Request) => {
		const url = new URL(outbound.url)
		seen.push([url.hostname, outbound.headers.get('authorization')])
		if (url.hostname !== 'login.microsoftonline.com') {
			return Response.json({ ok: true })
		}
		const scope = new URLSearchParams(await outbound.text()).get('scope')
		return Response.json({
			token_type: 'Bearer',
			expires_in: 3599,
			access_token: jwt(String(scope).replace('/.default', '')),
		})
	}) as unknown as typeof fetch
	const send = (url: string, init: RequestInit) =>
		executeGatewayFetch({
			env,
			props: { ...props, credentialClientBinding: 'run-a' },
			request: new Request(url, init),
			globalFetch,
		})
	const mint = async (scope: string) => {
		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			scope,
		})
		const token = (await (
			await send(
				'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						authorization: `Basic ${buildSecretPlaceholder({ name: 'clientSecret', scope: null })}`,
					},
					body: body.toString(),
				},
			)
		).json()) as Record<string, unknown>
		return `Bearer ${String(token.access_token)}`
	}
	const arm = await mint('https://management.azure.com/.default')
	const logs = await mint('https://api.loganalytics.io/.default')
	expect(arm).not.toContain('.sig')
	await send(
		'https://management.azure.com/subscriptions?api-version=2022-12-01',
		{
			headers: { Authorization: arm },
		},
	)
	await send('https://api.loganalytics.azure.com/v1/workspaces/w/query', {
		method: 'POST',
		headers: { Authorization: logs },
		body: '{}',
	})
	expect(seen.slice(2)).toEqual([
		['management.azure.com', `Bearer ${jwt('https://management.azure.com')}`],
		[
			'api.loganalytics.azure.com',
			`Bearer ${jwt('https://api.loganalytics.io')}`,
		],
	])
	await expect(
		send('https://collector.test/x', { headers: { Authorization: arm } }),
	).rejects.toThrow(
		/may only be sent to microsoftonline\.com, management\.azure\.com, not collector\.test/,
	)
	expect(seen).toHaveLength(4)
})

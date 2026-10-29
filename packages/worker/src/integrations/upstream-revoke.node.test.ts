import { expect, test } from 'vitest'
import { revokeOauthTokensUpstream } from './upstream-revoke.ts'

type Call = { url: string; init: RequestInit }

function recordingFetch(status: number | Error) {
	const calls: Array<Call> = []
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} })
		if (status instanceof Error) throw status
		return new Response(null, { status })
	}) as typeof fetch
	return { calls, fetchImpl }
}

const github = {
	provider: 'github',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	clientId: 'fixture-client-id',
}

test('GitHub OAuth apps revoke through the application token endpoint with app credentials', async () => {
	const { calls, fetchImpl } = recordingFetch(204)
	await expect(
		revokeOauthTokensUpstream({
			app: github,
			clientSecret: 'fixture-client-secret',
			accessToken: 'fixture-access-token',
			refreshToken: null,
			fetchImpl,
		}),
	).resolves.toEqual({ outcome: 'revoked', status: 204 })
	expect(calls).toHaveLength(1)
	expect(calls[0]!.url).toBe(
		'https://api.github.com/applications/fixture-client-id/token',
	)
	expect(calls[0]!.init.method).toBe('DELETE')
	const headers = new Headers(calls[0]!.init.headers)
	expect(headers.get('authorization')).toBe(
		`Basic ${btoa('fixture-client-id:fixture-client-secret')}`,
	)
	expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
		access_token: 'fixture-access-token',
	})
})

test('a token GitHub already forgot counts as already invalid', async () => {
	const { fetchImpl } = recordingFetch(404)
	await expect(
		revokeOauthTokensUpstream({
			app: github,
			clientSecret: 'fixture-client-secret',
			accessToken: 'fixture-access-token',
			refreshToken: null,
			fetchImpl,
		}),
	).resolves.toMatchObject({ outcome: 'already_invalid' })
})

test('RFC 7009 providers get a revocation request for the refresh token', async () => {
	const { calls, fetchImpl } = recordingFetch(200)
	await expect(
		revokeOauthTokensUpstream({
			app: {
				provider: 'google',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				clientId: 'fixture-client-id',
			},
			clientSecret: 'fixture-client-secret',
			accessToken: 'fixture-access-token',
			refreshToken: 'fixture-refresh-token',
			fetchImpl,
		}),
	).resolves.toMatchObject({ outcome: 'revoked' })
	expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke')
	expect(String(calls[0]!.init.body)).toContain('token=fixture-refresh-token')
})

test('providers without a known revocation endpoint are skipped, not failed', async () => {
	const { calls, fetchImpl } = recordingFetch(200)
	await expect(
		revokeOauthTokensUpstream({
			app: {
				provider: 'example',
				tokenUrl: 'https://auth.example.com/token',
				clientId: 'fixture-client-id',
			},
			clientSecret: null,
			accessToken: 'fixture-access-token',
			refreshToken: null,
			fetchImpl,
		}),
	).resolves.toEqual({ outcome: 'unsupported', status: null })
	expect(calls).toHaveLength(0)
})

test('network errors and provider errors report failed without throwing', async () => {
	for (const status of [new Error('offline'), 500] as const) {
		const { fetchImpl } = recordingFetch(status)
		await expect(
			revokeOauthTokensUpstream({
				app: github,
				clientSecret: 'fixture-client-secret',
				accessToken: 'fixture-access-token',
				refreshToken: null,
				fetchImpl,
			}),
		).resolves.toMatchObject({ outcome: 'failed' })
	}
})

test('nothing to revoke without a token', async () => {
	const { calls, fetchImpl } = recordingFetch(204)
	await expect(
		revokeOauthTokensUpstream({
			app: github,
			clientSecret: 'fixture-client-secret',
			accessToken: null,
			refreshToken: null,
			fetchImpl,
		}),
	).resolves.toMatchObject({ outcome: 'no_token' })
	expect(calls).toHaveLength(0)
})

test('a token host matching an Object prototype key is not a known revocation endpoint', async () => {
	const { calls, fetchImpl } = recordingFetch(200)
	await expect(
		revokeOauthTokensUpstream({
			app: {
				provider: 'example',
				tokenUrl: 'https://constructor/token',
				clientId: 'fixture-client-id',
			},
			clientSecret: null,
			accessToken: 'fixture-access-token',
			refreshToken: null,
			fetchImpl,
		}),
	).resolves.toEqual({ outcome: 'unsupported', status: null })
	expect(calls).toHaveLength(0)
})

test('an RFC 7009 400 is already invalid only for invalid_token', async () => {
	const google = {
		provider: 'google',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		clientId: 'fixture-client-id',
	}
	for (const [error, outcome] of [
		['invalid_token', 'already_invalid'],
		['invalid_request', 'failed'],
		[null, 'failed'],
	] as const) {
		const fetchImpl = (async () =>
			new Response(error ? JSON.stringify({ error }) : 'not json', {
				status: 400,
			})) as typeof fetch
		await expect(
			revokeOauthTokensUpstream({
				app: google,
				clientSecret: 'fixture-client-secret',
				accessToken: 'fixture-access-token',
				refreshToken: null,
				fetchImpl,
			}),
		).resolves.toEqual({ outcome, status: 400 })
	}
})

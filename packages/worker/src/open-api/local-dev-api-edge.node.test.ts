import { expect, test } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	buildLocalDevApiRequest,
	ensureLocalCliClientRegistration,
	isLocalDevApiRequest,
} from './local-dev-api-edge.ts'

const localEnv = { WRANGLER_IS_LOCAL_DEV: 'true' } as Env

test('only local dev loopback origins serve the Open API paths', () => {
	const at = (href: string, env: Env = localEnv) =>
		isLocalDevApiRequest(env, new URL(href))
	expect(at('http://localhost:3742/v1/tokens/device')).toBe(true)
	expect(at('http://127.0.0.1:3742/openapi.json')).toBe(true)
	expect(at('http://localhost:3742/account')).toBe(false)
	expect(at('https://kody.codes/v1/tokens/device')).toBe(false)
	expect(at('http://localhost:3742/v1/tokens', {} as Env)).toBe(false)
	expect(
		at('http://localhost:3742/v1/tokens', {
			WRANGLER_IS_LOCAL_DEV: 'false',
		} as Env),
	).toBe(false)
})

test('forwarded API requests drop cookies and internal headers', () => {
	const forwarded = buildLocalDevApiRequest(
		new Request('http://localhost:3742/v1/tokens/device', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer abc',
				Cookie: 'kody_session=secret',
				'X-Kody-Internal': '1',
				'Content-Type': 'application/json',
			},
			body: '{}',
		}),
	)
	expect(forwarded.headers.get('Authorization')).toBe('Bearer abc')
	expect(forwarded.headers.get('Cookie')).toBeNull()
	expect(forwarded.headers.get('X-Kody-Internal')).toBeNull()
	expect(forwarded.method).toBe('POST')
})

test('registers the local CLI client once and keeps an existing record', async () => {
	const { kv } = createMemoryKvNamespace()
	const env = { ...localEnv, OAUTH_KV: kv } as unknown as Env
	const origin = 'http://localhost:39001'
	await ensureLocalCliClientRegistration(env, origin)
	const key = `client:${origin}/oauth/cli-client-metadata.json`
	const stored = JSON.parse((await kv.get(key)) ?? 'null')
	expect(stored).toMatchObject({
		clientId: `${origin}/oauth/cli-client-metadata.json`,
		redirectUris: ['http://127.0.0.1:43742/callback'],
		tokenEndpointAuthMethod: 'none',
	})
	const other = 'http://localhost:39002'
	const otherKey = `client:${other}/oauth/cli-client-metadata.json`
	await kv.put(otherKey, '{"clientId":"kept"}')
	await ensureLocalCliClientRegistration(env, other)
	expect(await kv.get(otherKey)).toBe('{"clientId":"kept"}')
})

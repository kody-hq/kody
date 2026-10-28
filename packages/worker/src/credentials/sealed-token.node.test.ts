import { expect, test } from 'vitest'
import { parseIntegrationTokenPlaceholders } from '#mcp/secrets/placeholders.ts'
import {
	isSealedTokenName,
	openSealedToken,
	sealToken,
	sealTokenFields,
	sealTokenResponse,
	sealedTokenAudienceHosts,
	sealedTokenDomainForUrl,
} from './sealed-token.ts'

const env = { SECRET_STORE_KEY: 'test-sealing-key-material' }
const to = { org: 'org-1', binding: 'run-1', domains: ['example.com'] }

function fakeJwt(claims: Record<string, unknown>) {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString('base64url')
	return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`
}

function nameOf(placeholder: string) {
	const [name] = parseIntegrationTokenPlaceholders(placeholder)
	if (!name) throw new Error('expected one sealed placeholder')
	return name
}

async function open(
	placeholder: string,
	overrides: Partial<Parameters<typeof openSealedToken>[0]> = {},
) {
	return await openSealedToken({
		env,
		name: nameOf(placeholder),
		org: 'org-1',
		binding: 'run-1',
		requestHost: 'api.example.com',
		parts: ['header'],
		...overrides,
	})
}

test('a sealed token holds no readable value and opens only at its fill', async () => {
	const sealed = await sealToken({ env, value: 'minted-value', to })
	expect(sealed).not.toContain('minted-value')
	expect(isSealedTokenName(nameOf(sealed))).toBe(true)
	await expect(open(sealed)).resolves.toBe('minted-value')
	await expect(open(sealed, { parts: ['body'] })).resolves.toBe('minted-value')
})

test('a sealed token for an already expired lifetime does not get the cap', async () => {
	const sealed = await sealToken({
		env,
		value: 'minted-value',
		to,
		expiresInSeconds: -5,
		now: 0,
	})
	await expect(open(sealed, { now: 1 })).rejects.toThrow(/expired/)
})

test('a sealed token refuses another org, run, host, URL part, expiry, or tampering', async () => {
	const sealed = await sealToken({ env, value: 'minted-value', to, now: 0 })
	const late = { now: 2 * 60 * 60 * 1000 }
	await expect(open(sealed, { org: 'org-2', now: 1 })).rejects.toThrow(
		/another account/,
	)
	await expect(open(sealed, { binding: 'run-2', now: 1 })).rejects.toThrow(
		/another run/,
	)
	await expect(
		open(sealed, { requestHost: 'evil.test', now: 1 }),
	).rejects.toThrow(/may only be sent to example\.com, not evil\.test/)
	await expect(open(sealed, { parts: ['query'], now: 1 })).rejects.toThrow(
		/not the query/,
	)
	await expect(open(sealed, late)).rejects.toThrow(/expired/)
	const tampered = sealed.replace(/.(?=}}$)/, (char) =>
		char === 'A' ? 'B' : 'A',
	)
	await expect(open(tampered, { now: 1 })).rejects.toThrow(
		/not issued by this Kody/,
	)
	await expect(
		openSealedToken({
			env: { SECRET_STORE_KEY: 'another-sealing-key' },
			name: nameOf(sealed),
			org: 'org-1',
			binding: 'run-1',
			requestHost: 'api.example.com',
			parts: ['header'],
			now: 1,
		}),
	).rejects.toThrow(/not issued by this Kody/)
})

test('a token sealed without a run binding opens in any run of its org', async () => {
	const sealed = await sealToken({
		env,
		value: 'signed-jwt',
		to: { ...to, binding: null },
	})
	await expect(open(sealed, { binding: null })).resolves.toBe('signed-jwt')
	await expect(open(sealed, { binding: 'run-9' })).resolves.toBe('signed-jwt')
})

test('sealTokenFields seals access, refresh, and id tokens and keeps the rest', async () => {
	const sealed = await sealTokenFields({
		env,
		payload: {
			access_token: 'a-value',
			refresh_token: 'r-value',
			id_token: 'i-value',
			token_type: 'Bearer',
			expires_in: 60,
		},
		to,
	})
	expect(sealed).toMatchObject({ token_type: 'Bearer', expires_in: 60 })
	const text = JSON.stringify(sealed)
	for (const value of ['a-value', 'r-value', 'i-value']) {
		expect(text).not.toContain(value)
	}
	await expect(open(String(sealed?.access_token))).resolves.toBe('a-value')
	await expect(
		sealTokenFields({ env, payload: { ok: true }, to }),
	).resolves.toBeNull()
})

test('a token minted on another domain also fills on the credential approved hosts', async () => {
	const sealed = await sealTokenResponse({
		env,
		response: Response.json({ access_token: 'a-value' }, { status: 200 }),
		requestUrl: 'https://login.example-auth.com/oauth/token',
		approvedHosts: ['login.example-auth.com', '*.example.com'],
		org: 'org-1',
		binding: 'run-1',
	})
	const body = (await sealed.json()) as Record<string, unknown>
	await expect(open(String(body.access_token))).resolves.toBe('a-value')
	await expect(
		open(String(body.access_token), { requestHost: 'evil.test' }),
	).rejects.toThrow(/may only be sent to example-auth\.com, example\.com/)
})

test('sealTokenResponse seals JSON token responses and passes other bodies through', async () => {
	const sealed = await sealTokenResponse({
		env,
		response: Response.json(
			{ access_token: 'a-value', token_type: 'Bearer' },
			{ status: 200 },
		),
		requestUrl: 'https://auth.example.com/oauth/token',
		org: 'org-1',
		binding: 'run-1',
	})
	const body = (await sealed.json()) as Record<string, unknown>
	expect(JSON.stringify(body)).not.toContain('a-value')
	expect(body.token_type).toBe('Bearer')
	await expect(open(String(body.access_token))).resolves.toBe('a-value')

	const text = await sealTokenResponse({
		env,
		response: new Response('access_token=a-value', {
			headers: { 'content-type': 'text/plain' },
		}),
		requestUrl: 'https://auth.example.com/oauth/token',
		org: 'org-1',
		binding: 'run-1',
	})
	await expect(text.text()).resolves.toBe('access_token=a-value')
})

test('sealTokenResponse streams a body too big to be a token response through unchanged', async () => {
	const big = JSON.stringify({ items: 'x'.repeat(2 * 1024 * 1024) })
	const chunks = [big.slice(0, 1000), big.slice(1000)]
	const response = new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk))
				}
				controller.close()
			},
		}),
		{ headers: { 'content-type': 'application/json' } },
	)
	const passed = await sealTokenResponse({
		env,
		response,
		requestUrl: 'https://api.example.com/v1/items',
		org: 'org-1',
		binding: 'run-1',
	})
	await expect(passed.text()).resolves.toBe(big)
})

test('sealTokenResponse refuses a body too big to seal that names a token field', async () => {
	const big = JSON.stringify({
		items: 'x'.repeat(2 * 1024 * 1024),
		access_token: 'a-value',
	})
	const passed = await sealTokenResponse({
		env,
		response: new Response(big, {
			headers: { 'content-type': 'application/json' },
		}),
		requestUrl: 'https://auth.example.com/oauth/token',
		org: 'org-1',
		binding: 'run-1',
	})
	await expect(passed.text()).rejects.toThrow(/credential_placement_refused/)
})

test('sealTokenResponse keeps the upstream response url', async () => {
	const upstream = new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
	})
	Object.defineProperty(upstream, 'url', {
		value: 'https://api.example.com/v1/items',
	})
	const passed = await sealTokenResponse({
		env,
		response: upstream,
		requestUrl: 'https://api.example.com/v1/items',
		org: 'org-1',
		binding: 'run-1',
	})
	expect(passed.url).toBe('https://api.example.com/v1/items')
})

test('sealedTokenDomainForUrl uses the registrable domain', () => {
	expect(
		sealedTokenDomainForUrl('https://api-m.sandbox.example.co.uk/v1'),
	).toBe('example.co.uk')
	// Private suffixes keep sibling tenants apart.
	expect(sealedTokenDomainForUrl('https://tenant-a.github.io/x')).toBe(
		'tenant-a.github.io',
	)
	expect(sealedTokenDomainForUrl('not a url')).toBeNull()
})

async function sealEntraResponse(payload: Record<string, unknown>) {
	const sealed = await sealTokenResponse({
		env,
		response: Response.json(payload),
		requestUrl: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
		approvedHosts: ['login.microsoftonline.com'],
		org: 'org-1',
		binding: 'run-1',
	})
	return (await sealed.json()) as Record<string, string>
}

test('an Entra access token fills on its audience host without widening the client secret', async () => {
	const arm = await sealEntraResponse({
		access_token: fakeJwt({ aud: 'https://management.azure.com/' }),
		refresh_token: 'r-value',
	})
	await expect(
		open(arm.access_token!, { requestHost: 'management.azure.com' }),
	).resolves.toContain('.signature')
	await expect(
		open(arm.access_token!, { requestHost: 'login.microsoftonline.com' }),
	).resolves.toContain('.signature')
	// The exact audience host, not azure.com: tenant-named hosts stay out.
	await expect(
		open(arm.access_token!, {
			requestHost: 'attacker.eastus.cloudapp.azure.com',
		}),
	).rejects.toThrow(
		/may only be sent to microsoftonline\.com, management\.azure\.com, not attacker\.eastus\.cloudapp\.azure\.com\. It was issued for https:\/\/management\.azure\.com; if attacker\.eastus\.cloudapp\.azure\.com is a different API, mint a token whose scope or resource is/,
	)
	// Only the access token carries an audience; the refresh token stays put.
	await expect(
		open(arm.refresh_token!, { requestHost: 'management.azure.com' }),
	).rejects.toThrow(/may only be sent to microsoftonline\.com, not/)

	const logs = await sealEntraResponse({
		access_token: fakeJwt({ aud: 'https://api.loganalytics.io' }),
	})
	for (const requestHost of [
		'api.loganalytics.io',
		'api.loganalytics.azure.com',
	]) {
		await expect(open(logs.access_token!, { requestHost })).resolves.toContain(
			'.signature',
		)
	}
	await expect(
		open(logs.access_token!, { requestHost: 'management.azure.com' }),
	).rejects.toThrow(/issued for https:\/\/api\.loganalytics\.io/)
})

test('sealedTokenAudienceHosts reads only https audiences that name one host', () => {
	expect(
		sealedTokenAudienceHosts(
			fakeJwt({ aud: ['https://api.example.com/v1', 'api://default'] }),
		),
	).toEqual(['api.example.com'])
	expect(
		sealedTokenAudienceHosts(
			fakeJwt({ aud: 'https://management.core.windows.net/' }),
		),
	).toEqual(['management.core.windows.net', 'management.azure.com'])
	for (const aud of [
		'http://api.example.com',
		'https://azurewebsites.net',
		'https://localhost',
		'https://10.0.0.1',
		'00000003-0000-0000-c000-000000000000',
		42,
	]) {
		expect(sealedTokenAudienceHosts(fakeJwt({ aud }))).toEqual([])
	}
	expect(
		sealedTokenAudienceHosts(
			fakeJwt({ aud: ['https://api.example.com', 'https://evil.test'] }),
		),
	).toEqual([])
	expect(
		sealedTokenAudienceHosts(
			fakeJwt({
				aud: ['https://api.example.com', 'https://idp.example.org/userinfo'],
			}),
			['example.org'],
		),
	).toEqual(['api.example.com'])
	expect(sealedTokenAudienceHosts('opaque-token')).toEqual([])
	expect(sealedTokenAudienceHosts('a.!!!.c')).toEqual([])
})

test('an opaque token never fills on a host the token request only asked for', async () => {
	const opaque = await sealEntraResponse({
		access_token: 'opaque-value',
		scope: 'https://evil.test/.default',
	})
	await expect(
		open(opaque.access_token!, { requestHost: 'evil.test' }),
	).rejects.toThrow(
		/not evil\.test\. It names no https audience Kody can read\. If evil\.test is the API it is for, have the identity provider issue a JWT access token whose "aud" is https:\/\/evil\.test, or approve evil\.test on the credential that minted it\./,
	)
})

test('a refused secretJwtSign handle hints at send_to_host', async () => {
	const sealed = await sealToken({
		env,
		value: 'signed-jwt',
		to: { ...to, source: 'jwt-sign' },
	})
	await expect(open(sealed, { requestHost: 'evil.test' })).rejects.toThrow(
		/pass send_to_host: "evil\.test" to secretJwtSign/,
	)
})

test('an audience host fills exactly, not on its subdomains', async () => {
	const arm = await sealEntraResponse({
		access_token: fakeJwt({ aud: 'https://management.azure.com' }),
	})
	await expect(
		open(arm.access_token!, { requestHost: 'evil.management.azure.com' }),
	).rejects.toThrow(/not evil\.management\.azure\.com/)
})

test('a Basic-filled client secret echoed raw in a JWT keeps only the token and approved domains', async () => {
	const basic = Buffer.from('client-id:client-secret-value').toString('base64')
	const sealed = await sealTokenResponse({
		env,
		response: Response.json({
			access_token: fakeJwt({ aud: 'https://evil.test' }).replace(
				'signature',
				'client-secret-value',
			),
		}),
		requestUrl: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
		approvedHosts: ['login.microsoftonline.com'],
		filledValues: [`Basic ${basic}`, basic],
		org: 'org-1',
		binding: 'run-1',
	})
	const { access_token } = (await sealed.json()) as Record<string, string>
	await expect(
		open(access_token!, { requestHost: 'evil.test' }),
	).rejects.toThrow(/may only be sent to microsoftonline\.com, not evil\.test/)
})

test('a JWT whose claims carry the filled client id still fills on its audience', async () => {
	const sealed = await sealTokenResponse({
		env,
		response: Response.json({
			access_token: fakeJwt({
				aud: 'https://management.azure.com',
				appid: 'client-id-value',
			}),
		}),
		requestUrl: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
		approvedHosts: ['login.microsoftonline.com'],
		filledValues: ['client-id-value', 'client-secret-value'],
		org: 'org-1',
		binding: 'run-1',
	})
	const { access_token } = (await sealed.json()) as Record<string, string>
	await expect(
		open(access_token!, { requestHost: 'management.azure.com' }),
	).resolves.toMatch(/^eyJ/)
})

test('an approved Entra resource host still adds its documented alias', () => {
	expect(
		sealedTokenAudienceHosts(fakeJwt({ aud: 'https://api.loganalytics.io' }), [
			'api.loganalytics.io',
		]),
	).toEqual(['api.loganalytics.azure.com'])
	expect(
		sealedTokenAudienceHosts(fakeJwt({ aud: 'https://api.loganalytics.io' }), [
			'loganalytics.io',
			'azure.com',
		]),
	).toEqual([])
})

test('a token response that echoes a filled secret keeps only the token and approved domains', async () => {
	const echoed = fakeJwt({ aud: 'https://evil.test' }).replace(
		'signature',
		'client-secret-value',
	)
	const sealed = await sealTokenResponse({
		env,
		response: Response.json({ access_token: echoed }),
		requestUrl: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
		approvedHosts: ['login.microsoftonline.com'],
		filledValues: ['client-secret-value'],
		org: 'org-1',
		binding: 'run-1',
	})
	const { access_token } = (await sealed.json()) as Record<string, string>
	await expect(
		open(access_token!, { requestHost: 'evil.test' }),
	).rejects.toThrow(/may only be sent to microsoftonline\.com, not evil\.test/)
})

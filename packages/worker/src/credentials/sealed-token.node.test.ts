import { expect, test } from 'vitest'
import { parseIntegrationTokenPlaceholders } from '#mcp/secrets/placeholders.ts'
import {
	isSealedTokenName,
	openSealedToken,
	sealToken,
	sealTokenFields,
	sealTokenResponse,
	sealedTokenDomainForUrl,
} from './sealed-token.ts'

const env = { SECRET_STORE_KEY: 'test-sealing-key-material' }
const to = { org: 'org-1', binding: 'run-1', domains: ['example.com'] }

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

test('sealedTokenDomainForUrl uses the registrable domain', () => {
	expect(
		sealedTokenDomainForUrl('https://api-m.sandbox.example.co.uk/v1'),
	).toBe('example.co.uk')
	expect(sealedTokenDomainForUrl('not a url')).toBeNull()
})

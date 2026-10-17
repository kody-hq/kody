import { expect, test } from 'vitest'
import {
	saveSecretSchema,
	saveOAuthAppSchema,
	connectOAuthSchema,
} from './secret-mutations.ts'

test('secret edits distinguish omitted policy from explicit clearing and preserve secret text', () => {
	const fields = { name: 'API_KEY', value: ' secret ', scope: 'user' as const }
	const absent = saveSecretSchema.parse(fields)
	expect(Object.hasOwn(absent, 'expiresAt')).toBe(false)
	expect(Object.hasOwn(absent, 'provider')).toBe(false)
	expect(absent.value).toBe(' secret ')
	const cleared = saveSecretSchema.parse({
		...fields,
		expiresAt: null,
		provider: '',
	})
	expect(cleared.expiresAt).toBeNull()
	expect(cleared.provider).toBe('')
	expect(
		saveSecretSchema.safeParse({
			...fields,
			allowedHosts: ['api.example.com', 42],
		}).success,
	).toBe(false)
})

test('OAuth transport retains raw separators and provider token response fields', () => {
	const app = saveOAuthAppSchema.parse({
		provider: 'example',
		scopeSeparator: ' ',
		extraAuthorizeParams: { audience: 'api' },
	})
	expect(app.scopeSeparator).toBe(' ')
	const tokenPayload = {
		access_token: 'secret',
		expires_in: 3600,
		scope: 'read write',
		vendor: { tenant: 'one' },
	}
	expect(
		connectOAuthSchema.parse({ provider: 'example', tokenPayload })
			.tokenPayload,
	).toEqual(tokenPayload)
})

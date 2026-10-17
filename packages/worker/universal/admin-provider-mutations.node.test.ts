import { expect, test } from 'vitest'
import {
	platformIntegrationSaveSchema,
	providerMarkSaveSchema,
	adminProviderDeleteSchema,
} from './admin-provider-mutations.ts'

const integration = {
	slug: 'github',
	clientId: 'client',
	tokenUrl: 'https://provider.test/token',
	authorizeUrl: 'https://provider.test/authorize',
	flow: 'confidential',
}

test('integration input retains omitted credentials and distinguishes explicit clearing', () => {
	const retained = platformIntegrationSaveSchema.parse(integration)
	expect(retained).not.toHaveProperty('clientSecret')
	expect(retained).not.toHaveProperty('logoBase64')
	expect(retained).not.toHaveProperty('tokenExchangeStyle')
	expect(
		platformIntegrationSaveSchema.parse({
			...integration,
			clientSecret: null,
			logoBase64: '',
			tokenExchangeStyle: null,
		}),
	).toMatchObject({
		clientSecret: null,
		logoBase64: '',
		tokenExchangeStyle: null,
	})
})

test('named provider inputs strip dispatch fields and reject malformed settings', () => {
	expect(
		adminProviderDeleteSchema.parse({
			slug: 'github',
			action: 'save',
			clientSecret: 'secret',
		}),
	).toEqual({ slug: 'github' })
	expect(
		providerMarkSaveSchema.parse({ slug: 'github', action: 'delete' }),
	).toEqual({ slug: 'github' })
	expect(
		platformIntegrationSaveSchema.safeParse({
			...integration,
			visibility: 'Draft',
		}).success,
	).toBe(false)
	expect(
		platformIntegrationSaveSchema.safeParse({
			...integration,
			enabled: 'false',
		}).success,
	).toBe(false)
	expect(
		platformIntegrationSaveSchema.safeParse({
			...integration,
			extraAuthorizeParams: { prompt: [] },
		}).success,
	).toBe(false)
})

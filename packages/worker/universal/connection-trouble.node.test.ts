import { expect, test } from 'vitest'
import {
	expiredSecretCopy,
	integrationAuthFailureCopy,
	isVendorLikelyMcpError,
	toIntegrationAuthFailureView,
} from './connection-trouble.ts'

test('connection trouble copy names the actor and keeps vendor items off the you-queue', () => {
	const rejected = integrationAuthFailureCopy({
		name: 'google',
		accountLabel: 'kent@gmail.com',
		reason: 'provider_rejected',
		providerError: 'invalid_grant',
		providerErrorDescription: 'Token has been expired or revoked.',
	})
	expect(rejected).toMatchObject({
		who: 'you',
		reconnectable: true,
		href: '/connect/oauth?provider=google&loginHint=kent%40gmail.com',
	})

	const outage = integrationAuthFailureCopy({
		name: 'google',
		accountLabel: 'kent@gmail.com',
		reason: 'provider_unavailable',
		httpStatus: 503,
	})
	expect(outage).toMatchObject({
		who: 'the-service',
		reconnectable: false,
		href: '/account/integrations/google',
	})

	const platformSecret = integrationAuthFailureCopy({
		name: 'google',
		lane: 'platform',
		reason: 'missing_secret',
	})
	expect(platformSecret).toMatchObject({
		who: 'kody',
		reconnectable: false,
	})

	const expired = expiredSecretCopy('githubAccessToken')
	expect(expired).toMatchObject({
		who: 'you',
		href: '/account/secrets/user/githubAccessToken',
	})

	expect(isVendorLikelyMcpError('HTTP 503 from upstream')).toBe(true)
	expect(isVendorLikelyMcpError('fetch failed')).toBe(true)
	expect(isVendorLikelyMcpError('ECONNRESET')).toBe(true)
	expect(isVendorLikelyMcpError('Token exchange failed.')).toBe(false)
	expect(isVendorLikelyMcpError(null)).toBe(false)

	const view = toIntegrationAuthFailureView({
		name: 'spotify',
		reason: 'missing_refresh_token',
		occurredAt: '2026-09-01T00:00:00.000Z',
	})
	expect(view.reconnectHref).toBe('/connect/oauth?provider=spotify')
	expect(view.reconnectable).toBe(true)
	expect(view.who).toBe('you')
})

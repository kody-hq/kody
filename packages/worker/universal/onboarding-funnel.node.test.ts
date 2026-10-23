import { expect, test } from 'vitest'
import {
	sanitizeFunnelClientId,
	sanitizeMcpConnectErrorClass,
	sanitizeOnboardingFunnelPlan,
	sanitizeWaitingCardId,
} from './onboarding-funnel.ts'

test('waiting card ids drop secret names and unknown ids', () => {
	expect(sanitizeWaitingCardId('first-use:search')).toBe('first-use:search')
	expect(sanitizeWaitingCardId('onboarding:connect-agent')).toBe(
		'onboarding:connect-agent',
	)
	expect(sanitizeWaitingCardId('secret-expired:OPENAI_KEY')).toBe(
		'secret-expired',
	)
	expect(sanitizeWaitingCardId('secret-expired-more')).toBe(
		'secret-expired-more',
	)
	expect(sanitizeWaitingCardId('mcp-server:server-1')).toBe('mcp-server')
	expect(sanitizeWaitingCardId('integration-auth:github')).toBe(
		'integration-auth:github',
	)
	expect(sanitizeWaitingCardId('integration-auth:My Account')).toBe(
		'integration-auth',
	)
	expect(
		sanitizeWaitingCardId('publish-lock:11111111-1111-1111-1111-111111111111'),
	).toBe('publish-lock:11111111-1111-1111-1111-111111111111')
	expect(sanitizeWaitingCardId('enablement-paused:en-1')).toBe(
		'enablement-paused',
	)
	expect(sanitizeWaitingCardId('user@example.com')).toBeNull()
})

test('funnel dimensions stay closed', () => {
	expect(sanitizeOnboardingFunnelPlan('pro')).toBe('pro')
	expect(sanitizeOnboardingFunnelPlan('enterprise')).toBeNull()
	expect(sanitizeMcpConnectErrorClass('Invalid_Credentials')).toBe(
		'invalid_credentials',
	)
	expect(sanitizeMcpConnectErrorClass('token=secret')).toBe('other')
	expect(
		sanitizeFunnelClientId(
			'https://claude.ai/oauth/client?refresh_token=super-secret',
		),
	).toBe('claude.ai')
	expect(sanitizeFunnelClientId('user@example.com')).toBe('')
})

import { expect, test } from 'vitest'
import { type AccountIntegrationListItem } from '#universal/loader-data.ts'
import { toIntegrationAuthFailureView } from '#universal/connection-trouble.ts'
import {
	connectionStatusLabel,
	shouldShowReconnectAction,
} from '../../pages/account-integrations-shared.ts'

function integration(
	overrides: Partial<AccountIntegrationListItem> = {},
): AccountIntegrationListItem {
	return {
		name: 'google',
		appSlug: 'google',
		provider: 'google',
		appLabel: 'Google',
		accountLabel: 'kent@gmail.com',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		flow: 'confidential',
		clientId: 'client',
		hasClientSecret: false,
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: [],
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

test('connection status names who can fix a last auth failure', () => {
	expect(connectionStatusLabel(integration())).toBe('Connected')
	expect(
		connectionStatusLabel(
			integration({
				authorization: null,
			}),
		),
	).toBe('Needs setup')

	const you = integration({
		lastAuthFailure: toIntegrationAuthFailureView({
			name: 'google',
			accountLabel: 'kent@gmail.com',
			reason: 'provider_rejected',
			occurredAt: '2026-09-01T00:00:00.000Z',
		}),
	})
	expect(connectionStatusLabel(you)).toBe('Needs you')
	expect(shouldShowReconnectAction(you)).toBe(true)

	const vendor = integration({
		lastAuthFailure: toIntegrationAuthFailureView({
			name: 'google',
			reason: 'provider_unavailable',
			occurredAt: '2026-09-01T00:00:00.000Z',
			httpStatus: 503,
		}),
	})
	expect(connectionStatusLabel(vendor)).toBe('Service issue')
	expect(shouldShowReconnectAction(vendor)).toBe(false)
})

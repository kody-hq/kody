import { expect, test } from 'vitest'
import {
	isConnectSecretsAlreadyAllowed,
	readConnectSecretsView,
} from './pages/connect-secrets.tsx'

type ApprovalView = Parameters<
	typeof isConnectSecretsAlreadyAllowed
>[0]['approval']

const secret = {
	id: 'user:googleAccessToken',
	name: 'googleAccessToken',
	scope: 'user' as const,
	description: '',
	packageId: null,
	packageTitle: null,
	allowedHosts: ['oauth2.googleapis.com'],
	allowedPackages: [],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	expiresAt: null,
	ttlMs: null,
	placement: null,
}

const approval: ApprovalView = {
	name: 'googleAccessToken',
	names: ['googleAccessToken'],
	scope: 'user' as const,
	requestedHost: 'gmail.googleapis.com',
	requestedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
	rejectedHosts: [],
	requestedPackageId: null,
	currentAllowedHosts: ['oauth2.googleapis.com'],
	currentAllowedPackages: [],
}

test('connect secrets is already allowed only when every listed secret is present and every host is granted', () => {
	const allGranted = {
		...secret,
		allowedHosts: ['gmail.googleapis.com', 'oauth2.googleapis.com'],
	}
	const rejectedHosts = [
		{ host: 'api.ope', reason: 'unknown_suffix', message: 'truncated' },
	] as const
	const allowed = (
		secrets: Array<typeof secret>,
		overrides: Partial<typeof approval> = {},
	) =>
		isConnectSecretsAlreadyAllowed({
			secrets,
			approval: { ...approval, ...overrides },
		})

	expect(allowed([secret])).toBe(false)
	expect(allowed([allGranted])).toBe(true)
	expect(allowed([])).toBe(false)
	// Invalid (rejected) hosts do not block an otherwise fully granted request,
	// but a request with only invalid hosts is never "already allowed".
	expect(allowed([allGranted], { rejectedHosts: [...rejectedHosts] })).toBe(
		true,
	)
	expect(
		allowed([secret], {
			requestedHost: '',
			requestedHosts: [],
			rejectedHosts: [...rejectedHosts],
		}),
	).toBe(false)

	expect(
		readConnectSecretsView({
			hostCount: 1,
			rejectedCount: 1,
			completed: 'approve',
			alreadyAllowed: false,
		}),
	).toEqual({
		onlyInvalid: false,
		fullyAllowed: false,
		leftoverInvalid: true,
		showBackToSecrets: true,
	})
})

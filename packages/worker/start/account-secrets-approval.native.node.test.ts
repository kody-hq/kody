import { expect, test } from 'vitest'
import {
	isPackageSecretApprovalAlreadyGranted,
	readPackageSecretApprovalView,
} from './pages/account-secrets-approval.tsx'

const secret = {
	id: 'user:openai-api-key',
	name: 'openai-api-key',
	scope: 'user' as const,
	description: '',
	packageId: null,
	packageTitle: null,
	allowedHosts: [],
	allowedPackages: ['pkg-notes'],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	expiresAt: null,
	ttlMs: null,
}

const approval = {
	name: 'openai-api-key',
	names: ['openai-api-key'],
	scope: 'user' as const,
	requestedHost: '',
	requestedHosts: [],
	rejectedHosts: [],
	requestedPackageId: 'pkg-notes',
	currentAllowedHosts: [],
	currentAllowedPackages: [],
}

test('package secret already-granted checks match host-approval spirit', () => {
	const granted = (
		secrets: Array<typeof secret>,
		names: Array<string> = approval.names,
	) =>
		isPackageSecretApprovalAlreadyGranted({
			secrets,
			approval: { ...approval, names },
		})
	expect(granted([{ ...secret, allowedPackages: [] }])).toBe(false)
	expect(granted([secret])).toBe(true)
	expect(granted([])).toBe(false)
	expect(granted([secret], ['openai-api-key', 'missing'])).toBe(false)

	const views = [
		[null, false, { fullyAllowed: false, showBackToSecrets: false }],
		['approve', false, { fullyAllowed: true, showBackToSecrets: true }],
		[null, true, { fullyAllowed: true, showBackToSecrets: true }],
		['reject', false, { fullyAllowed: false, showBackToSecrets: true }],
	] as const
	expect(
		views.map(([completed, alreadyGranted]) => [
			completed,
			alreadyGranted,
			readPackageSecretApprovalView({ completed, alreadyGranted }),
		]),
	).toEqual(views)
})

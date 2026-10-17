import { expect, test } from 'vitest'
import {
	findMatchingSecretForSetup,
	hydrateEditorStateForExistingSecret,
	readConnectSecretSetView,
	readInvalidExpiresAtQuery,
	resolvePackageIdForSecretSet,
} from './pages/connect-secret-set-shared.ts'
import { createEmptyEditorState } from './pages/account-secrets-shared.ts'

test('connect secret-set view focuses the form when a name is present', () => {
	expect(
		readConnectSecretSetView({
			name: 'exampleApiKey',
			saved: false,
		}),
	).toEqual({
		hasName: true,
		saved: false,
		showForm: true,
		showBackToSecrets: false,
	})

	expect(
		readConnectSecretSetView({
			name: '',
			saved: false,
		}),
	).toEqual({
		hasName: false,
		saved: false,
		showForm: false,
		showBackToSecrets: true,
	})

	expect(
		readConnectSecretSetView({
			name: 'exampleApiKey',
			saved: true,
		}),
	).toEqual({
		hasName: true,
		saved: true,
		showForm: false,
		showBackToSecrets: true,
	})
})

test('findMatchingSecretForSetup resolves rotation targets by name and scope', () => {
	const secrets = [
		{
			id: 'user:exampleApiKey',
			name: 'exampleApiKey',
			scope: 'user' as const,
			description: 'Existing',
			packageId: null,
			packageTitle: null,
			allowedHosts: ['api.example.com'],
			allowedPackages: ['pkg_1'],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			expiresAt: null,
			ttlMs: null,
		},
		{
			id: 'package:pkg_2:token',
			name: 'token',
			scope: 'package' as const,
			description: '',
			packageId: 'pkg_2',
			packageTitle: 'Notes',
			allowedHosts: [],
			allowedPackages: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			expiresAt: null,
			ttlMs: null,
		},
	]

	expect(
		findMatchingSecretForSetup(secrets, {
			name: 'exampleApiKey',
			scope: 'user',
			packageId: '',
		})?.id,
	).toBe('user:exampleApiKey')
	expect(
		findMatchingSecretForSetup(
			secrets,
			{
				name: 'token',
				scope: 'package',
				packageId: 'pkg_2',
			},
			{ explicitPackageId: 'pkg_2' },
		)?.id,
	).toBe('package:pkg_2:token')
	// Editor fallback packageId without an explicit query packageId must not
	// match another package's secret.
	expect(
		findMatchingSecretForSetup(secrets, {
			name: 'token',
			scope: 'package',
			packageId: 'pkg_2',
		}),
	).toBeNull()
	expect(
		findMatchingSecretForSetup(
			secrets,
			{
				name: 'token',
				scope: 'package',
				packageId: 'pkg_other',
			},
			{ explicitPackageId: 'pkg_other' },
		),
	).toBeNull()
})

test('hydrateEditorStateForExistingSecret preserves policy unless the query sets it', () => {
	const existing = {
		id: 'user:exampleApiKey',
		name: 'exampleApiKey',
		scope: 'user' as const,
		description: 'Existing description',
		packageId: null,
		packageTitle: null,
		allowedHosts: ['api.example.com'],
		allowedPackages: ['pkg_1'],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		expiresAt: '2026-12-01T00:00:00.000Z',
		ttlMs: null,
	}
	const base = {
		...createEmptyEditorState([]),
		name: 'exampleApiKey',
		scope: 'user' as const,
	}

	expect(
		hydrateEditorStateForExistingSecret(
			base,
			existing,
			'/connect/secret-set?name=exampleApiKey',
		),
	).toMatchObject({
		currentId: 'user:exampleApiKey',
		description: 'Existing description',
		expiresAt: '2026-12-01T00:00:00.000Z',
		allowedHosts: ['api.example.com'],
		allowedPackages: ['pkg_1'],
	})

	// Empty policy params must not wipe existing grants.
	expect(
		hydrateEditorStateForExistingSecret(
			{ ...base, allowedHosts: [''], allowedPackages: [] },
			existing,
			'/connect/secret-set?name=exampleApiKey&allowedHosts=&allowedPackages=',
		),
	).toMatchObject({
		allowedHosts: ['api.example.com'],
		allowedPackages: ['pkg_1'],
	})

	// Invalid expiresAt must not clear an existing cutoff.
	expect(
		hydrateEditorStateForExistingSecret(
			{ ...base, expiresAt: '' },
			existing,
			'/connect/secret-set?name=exampleApiKey&expiresAt=not-a-date',
		),
	).toMatchObject({
		expiresAt: '2026-12-01T00:00:00.000Z',
	})

	expect(
		hydrateEditorStateForExistingSecret(
			{
				...base,
				description: 'From query',
				allowedHosts: ['new.example.com'],
				allowedPackages: ['pkg_2'],
			},
			existing,
			'/connect/secret-set?name=exampleApiKey&description=From%20query&allowedHosts=new.example.com&allowedPackages=pkg_2',
		),
	).toMatchObject({
		currentId: 'user:exampleApiKey',
		description: 'From query',
		allowedHosts: ['new.example.com'],
		allowedPackages: ['pkg_2'],
	})
})

test('readInvalidExpiresAtQuery validates the raw query independently of hydrated state', () => {
	expect(
		readInvalidExpiresAtQuery('/connect/secret-set?name=exampleApiKey'),
	).toBeNull()
	expect(
		readInvalidExpiresAtQuery(
			'/connect/secret-set?name=exampleApiKey&expiresAt=2026-12-01T00:00:00.000Z',
		),
	).toBeNull()
	expect(
		readInvalidExpiresAtQuery(
			'/connect/secret-set?name=exampleApiKey&expiresAt=not-a-date',
		),
	).toMatch(/invalid expiresAt/i)
})

test('resolvePackageIdForSecretSet rejects missing or unknown package ids', () => {
	expect(
		resolvePackageIdForSecretSet({
			scope: 'package',
			explicitPackageId: null,
			packageOptions: [{ id: 'pkg_1' }],
		}).error,
	).toMatch(/require a packageId/i)
	expect(
		resolvePackageIdForSecretSet({
			scope: 'package',
			explicitPackageId: 'pkg_missing',
			packageOptions: [{ id: 'pkg_1' }],
		}).error,
	).toMatch(/not available/i)
	expect(
		resolvePackageIdForSecretSet({
			scope: 'package',
			explicitPackageId: 'pkg_1',
			packageOptions: [{ id: 'pkg_1' }],
		}),
	).toEqual({ packageId: 'pkg_1' })
})

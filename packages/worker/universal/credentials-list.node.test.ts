import { expect, test } from 'vitest'
import { type CredentialListItem } from './credential-contracts.ts'
import {
	filterCredentialList,
	readCredentialListFilters,
	writeCredentialListQuery,
} from './credentials-list.ts'

test('writing filters replaces every filter key and keeps other params', () => {
	const params = new URLSearchParams('kind=secret&locked=true&tab=all')
	writeCredentialListQuery(params, {
		q: 'git',
		kinds: ['oauth', 'mcp'],
		scope: 'personal',
		locked: 'pkg-triage',
	})
	expect(params.toString()).toBe(
		'tab=all&q=git&kind=oauth&kind=mcp&scope=personal&locked=pkg-triage',
	)
	expect(readCredentialListFilters(params)).toEqual({
		q: 'git',
		kinds: ['oauth', 'mcp'],
		scope: 'personal',
		locked: 'pkg-triage',
	})
	writeCredentialListQuery(params, { packageScoped: false, locked: true })
	expect(readCredentialListFilters(params)).toEqual({
		packageScoped: false,
		locked: true,
	})
})

test('search matches every term across fields, like the old Secrets list', () => {
	const stripe: CredentialListItem = {
		id: 'c1',
		kind: 'secret',
		name: 'STRIPE_KEY',
		scope: 'org',
		provider: 'stripe',
		description: 'Billing live key',
		hosts: ['api.stripe.com'],
		inject: null,
		placement: null,
		packageId: null,
		lockedToPackageIds: ['pkg-billing'],
		expiresAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		status: 'ok',
		statusMessage: null,
		mcp: null,
	}
	const names = (q: string) =>
		filterCredentialList([stripe], { q }).map((item) => item.name)
	expect(names('stripe live')).toEqual(['STRIPE_KEY'])
	expect(names('pkg-billing')).toEqual(['STRIPE_KEY'])
	expect(names('stripe test')).toEqual([])
})

test('a chosen package matches its own keys and keys locked to it', () => {
	const base: CredentialListItem = {
		id: 'c1',
		kind: 'secret',
		name: 'OWN_KEY',
		scope: 'org',
		provider: null,
		description: '',
		hosts: [],
		inject: null,
		placement: null,
		packageId: 'pkg-billing',
		lockedToPackageIds: [],
		expiresAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		status: 'ok',
		statusMessage: null,
		mcp: null,
	}
	const items: Array<CredentialListItem> = [
		base,
		{
			...base,
			id: 'c2',
			name: 'LOCKED_KEY',
			packageId: null,
			lockedToPackageIds: ['pkg-billing'],
		},
		{ ...base, id: 'c3', name: 'OTHER_KEY', packageId: 'pkg-triage' },
	]
	const names = (filters: Parameters<typeof filterCredentialList>[1]) =>
		filterCredentialList(items, filters).map((item) => item.name)
	expect(names({ locked: 'pkg-billing' })).toEqual(['OWN_KEY', 'LOCKED_KEY'])
	expect(names({ locked: 'pkg-billing', packageScoped: true })).toEqual([
		'OWN_KEY',
	])
})

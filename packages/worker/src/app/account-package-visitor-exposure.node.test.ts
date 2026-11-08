import { expect, test } from 'vitest'
import { ownerCredentialItems } from './account-package-visitor-exposure.ts'

test('owner credential items skip storage and executor-supplied needs', () => {
	const items = ownerCredentialItems(
		[
			{
				kind: 'credential',
				credentialId: 'cred-1',
				name: 'GitHub token',
				source: 'need',
				needKey: 'github',
				hosts: ['api.github.com'],
				via: ['demo'],
			},
			{
				kind: 'credential',
				credentialId: 'cred-2',
				name: 'Visitor Linear',
				source: 'need',
				needKey: 'linear',
				hosts: [],
				via: ['demo'],
			},
			{
				kind: 'credential',
				credentialId: 'cred-3',
				name: 'Stripe',
				source: 'mount',
				hosts: ['api.stripe.com'],
				via: ['demo'],
			},
			{ kind: 'storage', storageId: 'store-1', hosts: [], via: ['demo'] },
		],
		new Set(['linear']),
	)
	expect(items).toEqual([
		{
			kind: 'credential',
			name: 'GitHub token',
			detail: 'credential("github")',
		},
		{ kind: 'credential', name: 'Stripe', detail: 'api.stripe.com' },
	])
	expect(ownerCredentialItems([], new Set())).toEqual([])
})

import { expect, test } from 'vitest'
import {
	mergeCredentialNeeds,
	ownCredentialNeeds,
	readStoredCredentialNeeds,
} from './credential-needs.ts'

test('own needs default provider to the key and sort by key', () => {
	expect(
		ownCredentialNeeds({
			google: { kind: 'oauth', multiple: true, description: 'Calendars.' },
			github_bot: {
				kind: 'oauth',
				provider: 'github',
				description: 'Bot account.',
			},
			github: { description: 'Read PRs to summarize them.' },
		}),
	).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'Read PRs to summarize them.',
			multiple: false,
		},
		{
			key: 'github_bot',
			kind: 'oauth',
			provider: 'github',
			description: 'Bot account.',
			multiple: false,
		},
		{
			key: 'google',
			kind: 'oauth',
			provider: 'google',
			description: 'Calendars.',
			multiple: true,
		},
	])
	expect(ownCredentialNeeds(undefined)).toEqual([])
})

test('the closure tags inherited needs with the declaring package and refuses kind or provider conflicts', () => {
	const own = ownCredentialNeeds({
		github: { kind: 'oauth', description: 'Repos.' },
	})
	const merged = mergeCredentialNeeds({
		own,
		dependencies: [
			{
				packageName: '@acme/triage',
				needs: [
					{
						key: 'github',
						kind: 'oauth',
						provider: 'github',
						description: 'Issues.',
						multiple: true,
					},
					{
						key: 'linear',
						kind: 'mcp',
						provider: 'linear',
						description: 'Linear.',
						multiple: false,
						from: '@acme/linear-tools',
					},
				],
			},
			{
				packageName: '@acme/notify',
				needs: [
					{
						key: 'resend',
						kind: 'secret',
						provider: 'resend',
						description: 'Email.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(merged.conflicts).toEqual([])
	expect(merged.needs).toEqual([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Repos.',
			multiple: true,
		},
		{
			key: 'linear',
			kind: 'mcp',
			provider: 'linear',
			description: 'Linear.',
			multiple: false,
			from: '@acme/linear-tools',
		},
		{
			key: 'resend',
			kind: 'secret',
			provider: 'resend',
			description: 'Email.',
			multiple: false,
			from: '@acme/notify',
		},
	])

	const conflict = mergeCredentialNeeds({
		own,
		dependencies: [
			{
				packageName: '@acme/other',
				needs: [
					{
						key: 'github',
						kind: 'secret',
						provider: 'github',
						description: 'PAT.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(conflict.conflicts).toHaveLength(1)
})

test('omitted kind merges with a fetch-capable declared kind and keeps the declared kind', () => {
	const merged = mergeCredentialNeeds({
		own: ownCredentialNeeds({
			github: { description: 'Read PRs.' },
		}),
		dependencies: [
			{
				packageName: '@acme/triage',
				needs: [
					{
						key: 'github',
						kind: 'oauth',
						provider: 'github',
						description: 'Issues.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(merged.conflicts).toEqual([])
	expect(merged.needs).toEqual([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Read PRs.',
			multiple: false,
		},
	])

	const bothOmit = mergeCredentialNeeds({
		own: ownCredentialNeeds({ github: { description: 'A.' } }),
		dependencies: [
			{
				packageName: '@acme/other',
				needs: [
					{
						key: 'github',
						provider: 'github',
						description: 'B.',
						multiple: true,
					},
				],
			},
		],
	})
	expect(bothOmit.conflicts).toEqual([])
	expect(bothOmit.needs).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'A.',
			multiple: true,
		},
	])

	const omitVsMcp = mergeCredentialNeeds({
		own: ownCredentialNeeds({ github: { description: 'A.' } }),
		dependencies: [
			{
				packageName: '@acme/mcp',
				needs: [
					{
						key: 'github',
						kind: 'mcp',
						provider: 'github',
						description: 'MCP.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(omitVsMcp.conflicts).toHaveLength(1)
})

test('owner credentials for visitors follow the declaring package through the closure', () => {
	const shared = {
		key: 'database',
		provider: 'database',
		description: 'Rooms.',
		multiple: false,
		ownerCredentialForVisitors: true as const,
	}
	expect(
		ownCredentialNeeds({
			database: { description: 'Rooms.', ownerCredentialForVisitors: true },
			github: { description: 'Repos.' },
		}),
	).toEqual([
		shared,
		{
			key: 'github',
			provider: 'github',
			description: 'Repos.',
			multiple: false,
		},
	])

	const inherited = mergeCredentialNeeds({
		own: [],
		dependencies: [{ packageName: '@acme/rooms', needs: [shared] }],
	})
	expect(inherited.needs).toEqual([{ ...shared, from: '@acme/rooms' }])
	expect(readStoredCredentialNeeds(inherited.needs)).toEqual(inherited.needs)
	expect(
		readStoredCredentialNeeds(inherited.needs, {
			supplierSemanticsEnabled: true,
		}),
	).toEqual([{ ...shared, from: '@acme/rooms', supplier: 'publisher' }])

	// A dependency cannot share a credential the package itself declares.
	const ownWins = mergeCredentialNeeds({
		own: ownCredentialNeeds({ database: { description: 'Mine.' } }),
		dependencies: [{ packageName: '@acme/rooms', needs: [shared] }],
	})
	expect(ownWins.needs).toEqual([
		{
			key: 'database',
			provider: 'database',
			description: 'Mine.',
			multiple: false,
		},
	])
	const ownShares = mergeCredentialNeeds({
		own: [shared],
		dependencies: [
			{
				packageName: '@acme/rooms',
				needs: [
					{
						key: 'database',
						provider: 'database',
						description: 'Theirs.',
						multiple: false,
					},
				],
			},
		],
	})
	expect(ownShares.needs).toEqual([shared])
})

test('supplier aliases normalize and executor required defaults to true when enabled', () => {
	expect(
		ownCredentialNeeds(
			{
				publisher: {
					description: 'Publisher access.',
					ownerCredentialForVisitors: true,
				},
				executor: {
					description: 'Visitor access.',
					supplier: 'executor',
				},
				optional: {
					description: 'Optional visitor access.',
					supplier: 'executor',
					required: false,
				},
			},
			{ supplierSemanticsEnabled: true },
		),
	).toEqual([
		{
			key: 'executor',
			provider: 'executor',
			description: 'Visitor access.',
			multiple: false,
			supplier: 'executor',
			required: true,
		},
		{
			key: 'optional',
			provider: 'optional',
			description: 'Optional visitor access.',
			multiple: false,
			supplier: 'executor',
			required: false,
		},
		{
			key: 'publisher',
			provider: 'publisher',
			description: 'Publisher access.',
			multiple: false,
			ownerCredentialForVisitors: true,
			supplier: 'publisher',
		},
	])
})

test('the flag-off closure merge ignores supplier metadata', () => {
	const merged = mergeCredentialNeeds({
		own: ownCredentialNeeds(
			{
				service: {
					description: 'Publisher access.',
					supplier: 'publisher',
				},
			},
			{ supplierSemanticsEnabled: false },
		),
		dependencies: [
			{
				packageName: '@fixture/dependency',
				needs: [
					{
						key: 'service',
						provider: 'service',
						description: 'Dependency access.',
						multiple: false,
						supplier: 'executor',
					},
				],
			},
		],
		supplierSemanticsEnabled: false,
	})

	expect(merged.conflicts).toEqual([])
	expect(merged.needs).toEqual([
		{
			key: 'service',
			provider: 'service',
			description: 'Publisher access.',
			multiple: false,
		},
	])
})

test('supplier closure permits publisher tightening and required tightening only', () => {
	const dependency = {
		key: 'service',
		provider: 'service',
		description: 'Dependency access.',
		multiple: false,
		supplier: 'executor' as const,
		required: false,
	}
	const tightened = mergeCredentialNeeds({
		own: ownCredentialNeeds(
			{
				service: {
					description: 'Publisher access.',
					supplier: 'publisher',
				},
				executor: {
					description: 'Required access.',
					supplier: 'executor',
				},
			},
			{ supplierSemanticsEnabled: true },
		),
		dependencies: [
			{
				packageName: '@fixture/dependency',
				needs: [
					dependency,
					{
						...dependency,
						key: 'executor',
						provider: 'executor',
						supplier: 'executor',
						required: false,
					},
				],
			},
		],
		supplierSemanticsEnabled: true,
	})
	expect(tightened.conflicts).toEqual([])
	expect(tightened.needs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ key: 'service', supplier: 'publisher' }),
			expect.objectContaining({
				key: 'executor',
				supplier: 'executor',
				required: true,
			}),
		]),
	)

	const loosened = mergeCredentialNeeds({
		own: ownCredentialNeeds(
			{
				service: {
					description: 'Executor access.',
					supplier: 'executor',
				},
				executor: {
					description: 'Optional access.',
					supplier: 'executor',
					required: false,
				},
			},
			{ supplierSemanticsEnabled: true },
		),
		dependencies: [
			{
				packageName: '@fixture/publisher',
				needs: [
					{
						...dependency,
						supplier: 'publisher',
						required: undefined,
					},
					{
						...dependency,
						key: 'executor',
						provider: 'executor',
						required: true,
					},
				],
			},
		],
		supplierSemanticsEnabled: true,
	})
	expect(loosened.conflicts).toHaveLength(2)
	expect(loosened.conflicts.join('\n')).toContain('@fixture/publisher')
})

test('a stored closure that does not parse counts as not stored', () => {
	expect(readStoredCredentialNeeds(null)).toBeNull()
	expect(readStoredCredentialNeeds([{ key: 'x' }])).toBeNull()
	expect(readStoredCredentialNeeds([])).toEqual([])
	expect(
		readStoredCredentialNeeds([
			{
				key: 'github',
				provider: 'github',
				description: 'Read PRs.',
				multiple: false,
			},
		]),
	).toEqual([
		{
			key: 'github',
			provider: 'github',
			description: 'Read PRs.',
			multiple: false,
		},
	])
	expect(
		readStoredCredentialNeeds([
			{
				key: 'legacy-owner',
				provider: 'legacy-owner',
				description: 'Legacy publisher access.',
				multiple: false,
				ownerCredentialForVisitors: true,
			},
			{
				key: 'executor',
				provider: 'executor',
				description: 'Executor access.',
				multiple: false,
				supplier: 'executor',
			},
		]),
	).toEqual([
		{
			key: 'legacy-owner',
			provider: 'legacy-owner',
			description: 'Legacy publisher access.',
			multiple: false,
			ownerCredentialForVisitors: true,
		},
		{
			key: 'executor',
			provider: 'executor',
			description: 'Executor access.',
			multiple: false,
		},
	])
})

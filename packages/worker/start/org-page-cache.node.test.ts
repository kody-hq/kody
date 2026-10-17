import { expect, test } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { updateOrgPagePayload } from './org-page-cache.ts'

test('a settled write updates only its initiating actor and workspace across list and detail entries', () => {
	const client = new QueryClient()
	const keys = [
		['page', 'alice', 'loadMcpServersPage', { orgSlug: 'one' }],
		[
			'page',
			'alice',
			'loadMcpServersPage',
			{ orgSlug: 'one', serverId: 'server' },
		],
		['page', 'alice', 'loadMcpServersPage', { orgSlug: 'two' }],
		['page', 'bob', 'loadMcpServersPage', { orgSlug: 'one' }],
	]
	for (const key of keys)
		client.setQueryData(key, {
			payload: { revision: 0 },
			head: { title: 'kept' },
		})
	updateOrgPagePayload<{ revision: number }>(
		client,
		'alice',
		'loadMcpServersPage',
		{ orgSlug: 'one' },
		() => ({ revision: 1 }),
	)
	expect(keys.map((key) => client.getQueryData(key))).toEqual(
		[1, 1, 0, 0].map((revision) => ({
			payload: { revision },
			head: { title: 'kept' },
		})),
	)
	client.clear()
})

test('personal typed pages refresh without touching organization or other actor caches', () => {
	const client = new QueryClient()
	const keys = [
		['page', 'alice', 'loadConnectionsPage', {}],
		['page', 'alice', 'loadConnectionsPage', { clientId: 'agent' }],
		['page', 'alice', 'loadConnectionsPage', { orgSlug: 'team' }],
		['page', 'bob', 'loadConnectionsPage', {}],
	]
	for (const key of keys) client.setQueryData(key, { payload: { revision: 0 } })
	updateOrgPagePayload<{ revision: number }>(
		client,
		'alice',
		'loadConnectionsPage',
		{ orgSlug: null },
		() => ({ revision: 1 }),
	)
	expect(keys.map((key) => client.getQueryData(key))).toEqual(
		[1, 1, 0, 0].map((revision) => ({ payload: { revision } })),
	)
	client.clear()
})

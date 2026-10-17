import {
	MutationObserver,
	QueryClient,
	QueryObserver,
} from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { mcpServerMutationOptions } from './pages/account-mcp-server-mutation.ts'

test.each([false, true])(
	'MCP server reconciliation preserves submitted scope after response loss: %s',
	async (lost) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadMcpServersPage', { orgSlug: 'org-a' }]
		const otherOrg = [
			'page',
			'actor-a',
			'loadMcpServersPage',
			{ orgSlug: 'org-b' },
		]
		const otherActor = [
			'page',
			'actor-b',
			'loadMcpServersPage',
			{ orgSlug: 'org-a' },
		]
		for (const entry of [key, otherOrg, otherActor])
			client.setQueryData(entry, {})
		const scope = { actorKey: 'actor-a', orgSlug: 'org-a' }
		const observer = new MutationObserver(
			client,
			mcpServerMutationOptions(client, scope, async (_id: string) => {
				scope.actorKey = 'actor-b'
				scope.orgSlug = 'org-b'
				if (lost) throw new Error('Response lost')
				return { ok: true }
			}),
		)
		await observer.mutate('server-1').catch(() => undefined)
		expect(client.getQueryState(key)?.isInvalidated).toBe(true)
		expect(client.getQueryState(otherOrg)?.isInvalidated).toBe(false)
		expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
		client.clear()
	},
)

test.each([false, true])(
	'active MCP page refetches persisted state after settlement, lost response: %s',
	async (lost) => {
		const client = new QueryClient()
		const key = ['page', 'actor-a', 'loadMcpServersPage', { orgSlug: 'org-a' }]
		client.setQueryData(key, { enabled: true })
		let enabled = true
		let reads = 0
		const page = new QueryObserver(client, {
			queryKey: key,
			staleTime: Infinity,
			queryFn: async () => {
				reads++
				return { enabled }
			},
		})
		const unsubscribe = page.subscribe(() => {})
		const mutation = new MutationObserver(
			client,
			mcpServerMutationOptions(
				client,
				{ actorKey: 'actor-a', orgSlug: 'org-a' },
				async (_id: string) => {
					enabled = false
					if (lost) throw new Error('Response lost')
					return { ok: true }
				},
			),
		)
		await mutation.mutate('server-1').catch(() => undefined)
		expect(reads).toBe(1)
		expect(client.getQueryData(key)).toEqual({ enabled: false })
		unsubscribe()
		client.clear()
	},
)

import { QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { connectedAgentMutationOptions } from './connected-agent-mutation.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'

const nativeMutation = vi.hoisted(() => vi.fn())
vi.mock('#start/server/account-mutations', () => ({
	revokeConnectedAgent: nativeMutation,
}))

function makeAgent(
	clientId: string,
	label: string,
	kind: AccountConnectedAgentListItem['kind'],
	connectedAt: string,
	lastUsedAt: string | null = null,
): AccountConnectedAgentListItem {
	return {
		clientId,
		grantIds: [`grant-${clientId}`],
		connectionProfileName: null,
		label,
		kind,
		connectedAt,
		lastUsedAt,
	}
}

const cursorOld = makeAgent(
	'cursor-old',
	'Cursor',
	'cursor',
	'2024-01-01T00:00:00.000Z',
	'2024-08-01T00:00:00.000Z',
)
const cursorNew = makeAgent(
	'cursor-new',
	'Cursor',
	'cursor',
	'2024-06-01T00:00:00.000Z',
	'2024-05-01T00:00:00.000Z',
)
const chatgptOld = makeAgent(
	'https://chatgpt.com/oauth/vG3/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-03-01T00:00:00.000Z',
)
const chatgptNew = makeAgent(
	'https://chatgpt.com/oauth/vG4/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-04-01T00:00:00.000Z',
)
const acme = makeAgent(
	'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
	'Acme Agent',
	null,
	'2024-05-01T00:00:00.000Z',
)
const allAgents = [cursorOld, cursorNew, chatgptOld, chatgptNew, acme]

const listedAgents: AccountConnectedAgentsLoaderData = {
	ok: true,
	mcpServerUrl: 'https://kody.example/mcp',
	agents: allAgents,
}

const clientIds = (agents: Array<AccountConnectedAgentListItem>) =>
	agents.map((agent) => agent.clientId)

function harness() {
	vi.stubGlobal('window', { location: { origin: 'https://kody.test' } })
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	const resolvers = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>()
	nativeMutation.mockImplementation(
		({ data }: { data: { orgSlug: string; clientId: string } }) =>
			new Promise((resolve, reject) => {
				expect(data.orgSlug).toBe('one')
				resolvers.set(data.clientId, { resolve, reject })
			}),
	)

	const key = (org: string, actor = 'actor') =>
		['page', actor, 'loadConnectionsPage', { orgSlug: org }] as const
	const seed = (org: string, actor = 'actor') =>
		client.setQueryData(key(org, actor), { payload: listedAgents })
	const ids = (org: string, actor = 'actor') =>
		clientIds(
			client
				.getQueryData<{ payload: AccountConnectedAgentsLoaderData }>(
					key(org, actor),
				)!
				.payload.agents.filter(
					(agent) =>
						!client
							.getMutationCache()
							.findAll({
								mutationKey: ['connectedAgents', actor, org],
								exact: true,
								status: 'pending',
							})
							.some(
								(mutation) =>
									(mutation.state.variables as { clientId: string })
										.clientId === agent.clientId,
							),
				),
		)
	const revoke = (clientId: string, org = 'one', actorKey = 'actor') =>
		client
			.getMutationCache()
			.build(client, {
				...connectedAgentMutationOptions(client),
				mutationKey: ['connectedAgents', actorKey, org],
			})
			.execute({ clientId, orgSlug: org, actorKey })
			.then(
				() => null,
				(error: unknown) => error,
			)
	const respond = (id: string, status = 200) => {
		const pending = resolvers.get(id)!
		if (status === 200) pending.resolve({ ok: true })
		else pending.reject(new Error('Denied.'))
	}

	return {
		client,
		key,
		seed,
		ids,
		revoke,
		respond,
		resolvers,
		[Symbol.dispose]() {
			client.clear()
			vi.unstubAllGlobals()
		},
	}
}

test('revoke optimistically removes only its row and failure restores it', async () => {
	using h = harness()
	h.seed('one')
	const pending = h.revoke(cursorOld.clientId)
	await vi.waitFor(() => expect(h.resolvers.has(cursorOld.clientId)).toBe(true))
	expect(h.ids('one')).not.toContain(cursorOld.clientId)
	expect(h.ids('one')).toContain(cursorNew.clientId)
	h.respond(cursorOld.clientId, 403)
	expect(await pending).toBeInstanceOf(Error)
	expect(h.ids('one')).toEqual(expect.arrayContaining(clientIds(allAgents)))
})

test('concurrent revokes project independently while each outcome confirms server state', async () => {
	using h = harness()
	h.seed('one')
	const first = h.revoke(cursorOld.clientId),
		second = h.revoke(cursorNew.clientId)
	await vi.waitFor(() => expect(h.resolvers.size).toBe(2))
	expect(h.ids('one')).not.toContain(cursorOld.clientId)
	expect(h.ids('one')).not.toContain(cursorNew.clientId)
	h.respond(cursorOld.clientId)
	expect(await first).toBeNull()
	expect(h.client.getQueryState(h.key('one'))?.isInvalidated).toBe(true)
	h.respond(cursorNew.clientId)
	expect(await second).toBeNull()
	expect(h.ids('one')).not.toContain(cursorOld.clientId)
	expect(h.ids('one')).not.toContain(cursorNew.clientId)
	expect(h.client.getQueryState(h.key('one'))?.isInvalidated).toBe(true)
})

test.each([200, 403])(
	'late revoke outcome %s remains scoped to submitted organization and actor',
	async (status) => {
		using h = harness()
		h.seed('one')
		h.seed('two')
		h.seed('one', 'other-actor')
		const usageKey = (org: string, actor = 'actor') => [
			'page',
			actor,
			'loadConnectionUsagePage',
			{ orgSlug: org },
		]
		for (const key of [
			usageKey('one'),
			usageKey('two'),
			usageKey('one', 'other-actor'),
		])
			h.client.setQueryData(key, { usage: [] })
		const pending = h.revoke(cursorOld.clientId)
		await vi.waitFor(() =>
			expect(h.resolvers.has(cursorOld.clientId)).toBe(true),
		)
		h.respond(cursorOld.clientId, status)
		await pending
		expect(h.ids('two')).toEqual(clientIds(allAgents))
		expect(h.ids('one', 'other-actor')).toEqual(clientIds(allAgents))
		expect(h.client.getQueryState(h.key('two'))?.isInvalidated).toBe(false)
		expect(
			h.client.getQueryState(h.key('one', 'other-actor'))?.isInvalidated,
		).toBe(false)
		expect(h.ids('one').includes(cursorOld.clientId)).toBe(status !== 200)
		expect(h.client.getQueryState(usageKey('one'))?.isInvalidated).toBe(true)
		expect(h.client.getQueryState(usageKey('two'))?.isInvalidated).toBe(false)
		expect(
			h.client.getQueryState(usageKey('one', 'other-actor'))?.isInvalidated,
		).toBe(false)
	},
)

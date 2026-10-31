import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
} from '#worker/connected-mcp-agents.ts'
import {
	listInboundMcpConnectionLastUsed,
	recordInboundMcpConnectionLastUsed,
} from '#worker/inbound-mcp-connection-last-used.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

type TestGrant = {
	id: string
	clientId: string
	createdAt?: number
	redirectUri?: string
	metadata?: unknown
}

const chatgptClientId = 'https://chatgpt.com/oauth/vG3/client.json'
const chatgptRedirect = 'https://chatgpt.com/connector/oauth/vG3'
const claudeRedirect = 'https://claude.ai/api/mcp/auth_callback'

function grant(
	id: string,
	clientId: string,
	createdAt?: number,
	redirectUri?: string,
): TestGrant {
	return { id, clientId, createdAt, redirectUri }
}

function createHelpers(input: {
	grants: Array<TestGrant>
	clients?: Record<
		string,
		{ clientName?: string; redirectUris?: Array<string> }
	>
	lookupThrows?: boolean
}): OAuthGrantHelpers & { revoked: Array<string> } {
	const revoked = new Array<string>()
	const withScope = (grants: Array<TestGrant>) =>
		grants.map((item) => ({ ...item, scope: ['profile'] }))
	return {
		revoked,
		async listUserGrants(_userId, options) {
			if (options?.cursor === 'page-2') {
				return { items: withScope(input.grants.slice(1)) }
			}
			return {
				items: withScope(input.grants.slice(0, 1)),
				...(input.grants.length > 1 ? { cursor: 'page-2' } : {}),
			}
		},
		async revokeGrant(grantId) {
			revoked.push(grantId)
		},
		async lookupClient(clientId) {
			if (input.lookupThrows) throw new Error('cimd lookup failed')
			const client = input.clients?.[clientId]
			if (!client) return null
			return { clientId, ...client }
		},
	}
}

function loadState(input: Parameters<typeof createHelpers>[0]) {
	return loadInboundMcpConnectionState(
		createHelpers(input),
		ownerIdFromStored('user-1'),
	)
}

test('inbound connection state pages grants and counts unique clientIds', async () => {
	const sameClient = await loadState({
		grants: [
			grant('grant-1', 'client-a', 1_700_000_000),
			grant('grant-2', 'client-a', 1_700_000_100),
		],
		clients: { 'client-a': { clientName: 'Cursor' } },
	})
	expect(sameClient.uniqueClientCount).toBe(1)
	expect(sameClient.agents).toEqual([
		{
			clientId: 'client-a',
			grantIds: ['grant-1', 'grant-2'],
			label: 'Cursor',
			kind: 'cursor',
			connectedAt: '2023-11-14T22:13:20.000Z',
			lastUsedAt: null,
		},
	])

	const twoClients = await loadState({
		grants: [
			grant('grant-1', chatgptClientId, 1_700_000_200, chatgptRedirect),
			grant('grant-2', 'anon-claude', 1_700_000_000, claudeRedirect),
		],
		clients: { [chatgptClientId]: { clientName: 'ChatGPT' } },
	})
	expect(twoClients.uniqueClientCount).toBe(2)
	expect(twoClients.agents.map((agent) => agent.label)).toEqual([
		'ChatGPT.com',
		'Claude Desktop',
	])
	expect(twoClients.agents[1]).toMatchObject({
		clientId: 'anon-claude',
		kind: 'claude-desktop',
		connectedAt: '2023-11-14T22:13:20.000Z',
	})
})

test('a ChatGPT grant never marks Claude connected, including a phone callback with no client name', async () => {
	const chatgpt = await loadState({
		grants: [
			grant('grant-chatgpt', chatgptClientId, 1_700_000_200, chatgptRedirect),
		],
		clients: {
			[chatgptClientId]: {
				clientName: 'ChatGPT',
				redirectUris: [chatgptRedirect],
			},
		},
	})
	expect(chatgpt.uniqueClientCount).toBe(1)
	expect(chatgpt.agents.map((agent) => agent.kind)).toEqual(['chatgpt'])
	expect(chatgpt.agents[0]).toMatchObject({ label: 'ChatGPT.com' })

	const phoneWithoutName = await loadState({
		grants: [
			grant(
				'grant-phone',
				'https://chatgpt.com/oauth/claude-model/client.json',
				1_700_000_300,
				'https://chatgpt.com/backend-api/aip/connectors/callback',
			),
		],
	})
	expect(phoneWithoutName.agents.map((agent) => agent.kind)).toEqual([
		'chatgpt',
	])

	const nameBeatsAClaudeRedirect = await loadState({
		grants: [
			grant(
				'grant-mixed',
				'opaque-chatgpt-client',
				1_700_000_400,
				claudeRedirect,
			),
		],
		clients: {
			'opaque-chatgpt-client': {
				clientName: 'ChatGPT',
				redirectUris: [claudeRedirect],
			},
		},
	})
	expect(nameBeatsAClaudeRedirect.agents.map((agent) => agent.kind)).toEqual([
		'chatgpt',
	])
})

test('inbound labels fall back when lookupClient is missing or throws', async () => {
	const withoutLookup = await loadInboundMcpConnectionState(
		{
			async listUserGrants() {
				return {
					items: [
						{
							id: 'grant-1',
							clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
							scope: ['profile'],
						},
					],
				}
			},
		},
		ownerIdFromStored('user-1'),
	)
	expect(withoutLookup.agents[0]).toMatchObject({
		kind: null,
		label: 'opaque-c…',
	})

	const lookupFailed = await loadState({
		grants: [grant('grant-1', 'https://unknown.example/oauth/client.json')],
		lookupThrows: true,
	})
	expect(lookupFailed.agents[0]).toMatchObject({
		kind: null,
		label: 'unknown.example',
	})

	expect(
		await loadInboundMcpConnectionState(undefined, ownerIdFromStored('user-1')),
	).toEqual({
		uniqueClientCount: 0,
		agents: [],
	})

	const listingFailed = await loadInboundMcpConnectionState(
		{
			async listUserGrants() {
				throw new Error('provider unavailable')
			},
		},
		ownerIdFromStored('user-1'),
	)
	expect(listingFailed).toEqual({
		uniqueClientCount: 0,
		agents: [],
		listingFailed: true,
	})
})

test('revokeConnectedMcpAgent revokes every grant for that clientId', async () => {
	const helpers = createHelpers({
		grants: [
			grant('grant-1', 'client-a'),
			grant('grant-2', 'client-a'),
			grant('grant-3', 'client-b'),
		],
	})
	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId: ownerIdFromStored('user-1'),
			clientId: 'client-a',
		}),
	).resolves.toEqual({ revoked: 2, clientRemains: false })
	expect(helpers.revoked).toEqual(['grant-1', 'grant-2'])
	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId: ownerIdFromStored('user-1'),
			clientId: 'missing',
		}),
	).resolves.toEqual({ error: 'not_found', clientRemains: false })
})

test('inbound connection state joins last-used and revoke forgets that stamp', async () => {
	const meter = createInMemoryUserMeterEnv()
	const userId = ownerIdFromStored(`user-${crypto.randomUUID()}`)
	const helpers = createHelpers({
		grants: [
			grant('grant-stale', 'client-stale', 1_710_000_000),
			grant('grant-active', 'client-active', 1_700_000_000),
			grant('grant-unused', 'client-unused', 1_720_000_000),
		],
		clients: {
			'client-stale': { clientName: 'Cursor' },
			'client-active': { clientName: 'Cursor' },
			'client-unused': { clientName: 'ChatGPT' },
		},
	})
	for (const [clientId, lastUsedAt] of [
		['client-stale', '2026-03-10T00:00:00.000Z'],
		['client-active', '2026-03-20T00:00:00.000Z'],
	] as const) {
		await recordInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
			clientId,
			lastUsedAt,
			nowMs: Date.parse(lastUsedAt),
		})
	}
	const lastUsedByClient = (
		state: Awaited<ReturnType<typeof loadInboundMcpConnectionState>>,
	) => state.agents.map((agent) => [agent.clientId, agent.lastUsedAt])

	expect(
		lastUsedByClient(await loadInboundMcpConnectionState(helpers, userId)),
	).toEqual([
		['client-unused', null],
		['client-stale', null],
		['client-active', null],
	])
	expect(
		lastUsedByClient(
			await loadInboundMcpConnectionState(helpers, userId, { env: meter.env }),
		),
	).toEqual([
		['client-active', '2026-03-20T00:00:00.000Z'],
		['client-stale', '2026-03-10T00:00:00.000Z'],
		['client-unused', null],
	])

	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId,
			clientId: 'client-active',
			env: meter.env,
		}),
	).resolves.toEqual({ revoked: 1, clientRemains: false })
	expect(
		await listInboundMcpConnectionLastUsed({ env: meter.env, userId: userId }),
	).toEqual(new Map([['client-stale', '2026-03-10T00:00:00.000Z']]))
})

test('an org filter lists only agents approved for that org', async () => {
	const personId = ownerIdFromStored('user-1')
	const teamId = ownerIdFromStored('org-acme')
	const helpers = createHelpers({
		grants: [
			// Before org stamping: the signup org.
			grant('grant-legacy', 'client-cursor', 1_700_000_000),
			{
				...grant('grant-personal', 'client-chatgpt', 1_700_000_100),
				metadata: { orgId: 'user-1' },
			},
			{
				...grant('grant-team', 'client-cursor', 1_700_000_200),
				metadata: { orgId: 'org-acme' },
			},
		],
		clients: {
			'client-cursor': { clientName: 'Cursor' },
			'client-chatgpt': { clientName: 'ChatGPT' },
		},
	})
	const agentGrants = (
		state: Awaited<ReturnType<typeof loadInboundMcpConnectionState>>,
	) => state.agents.map((agent) => [agent.clientId, agent.grantIds])

	expect(
		agentGrants(
			await loadInboundMcpConnectionState(helpers, personId, {
				orgId: teamId,
			}),
		),
	).toEqual([['client-cursor', ['grant-team']]])
	expect(
		agentGrants(
			await loadInboundMcpConnectionState(helpers, personId, {
				orgId: personId,
			}),
		),
	).toEqual([
		['client-chatgpt', ['grant-personal']],
		['client-cursor', ['grant-legacy']],
	])
})

test('revoking from an org keeps the same agent in other orgs and its last-used stamp', async () => {
	const meter = createInMemoryUserMeterEnv()
	const personId = ownerIdFromStored(`user-${crypto.randomUUID()}`)
	const teamId = ownerIdFromStored('org-acme')
	const helpers = createHelpers({
		grants: [
			grant('grant-personal', 'client-cursor'),
			{ ...grant('grant-team', 'client-cursor'), metadata: { orgId: teamId } },
			grant('grant-other', 'client-chatgpt'),
		],
	})
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId: personId,
		clientId: 'client-cursor',
		lastUsedAt: '2026-03-20T00:00:00.000Z',
		nowMs: Date.parse('2026-03-20T00:00:00.000Z'),
	})

	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId: personId,
			clientId: 'client-chatgpt',
			orgId: teamId,
			env: meter.env,
		}),
	).resolves.toEqual({ error: 'not_found', clientRemains: true })
	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId: personId,
			clientId: 'client-cursor',
			orgId: teamId,
			env: meter.env,
		}),
	).resolves.toEqual({ revoked: 1, clientRemains: true })
	expect(helpers.revoked).toEqual(['grant-team'])
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: personId,
		}),
	).toEqual(new Map([['client-cursor', '2026-03-20T00:00:00.000Z']]))
})

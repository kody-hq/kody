import { expect, test } from 'vitest'
import {
	type ConnectedMcpAgent,
	connectedAgentConnectionLabel,
	classifyMcpClientName,
	countUniqueOAuthClientIds,
	groupConnectedAgents,
	labelInboundMcpClient,
	latestConnectedAt,
	oauthGrantCreatedAtIso,
	truncateClientIdLabel,
	uniqueOAuthClientIds,
} from './connected-mcp-agents.ts'

function agent(
	clientId: string,
	label: string,
	kind: ConnectedMcpAgent['kind'],
	connectedAt: string | null,
	lastUsedAt: string | null = null,
): ConnectedMcpAgent {
	return { clientId, label, kind, connectedAt, lastUsedAt }
}

test('unique client counting treats two grants for the same client as one', () => {
	expect(
		countUniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: 'client-a' },
		]),
	).toBe(1)
	expect(
		uniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: ' client-b ' },
			{ clientId: '' },
			{ clientId: null },
		]),
	).toEqual(['client-a', 'client-b'])
	expect(
		countUniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: 'client-b' },
		]),
	).toBe(2)
})

test('inbound labels prefer a known kind, then clientName, then hostname, then a truncated clientId', () => {
	const cursorLocalRedirect = 'cursor://anysphere.cursor-mcp/oauth/callback'
	const cursorCloudRedirect = 'https://www.cursor.com/agents/mcp/oauth/callback'
	const inbound: Array<
		[Parameters<typeof labelInboundMcpClient>[0], string | null, string]
	> = [
		[
			{
				clientId: 'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json',
				clientName: 'ChatGPT',
				grantRedirectUri: 'https://chatgpt.com/connector/oauth/vG3-MLZWUV83',
			},
			'chatgpt',
			'ChatGPT.com',
		],
		[
			{
				clientId: 'anon-claude',
				clientName: 'Claude',
				grantRedirectUri: 'https://claude.ai/api/mcp/auth_callback',
			},
			'claude-desktop',
			'Claude Desktop',
		],
		[{ clientId: 'cursor-local', clientName: 'Cursor' }, 'cursor', 'Cursor'],
		[
			{
				clientId: 'cursor-ide',
				clientName: 'Cursor',
				grantRedirectUri: cursorLocalRedirect,
			},
			'cursor-local',
			'Cursor Local',
		],
		[
			{
				clientId: 'cursor-agent',
				clientName: 'Cursor',
				grantRedirectUri: cursorCloudRedirect,
			},
			'cursor-cloud',
			'Cursor Cloud',
		],
		[
			{
				clientId: 'cursor-registered-all',
				clientName: 'Cursor',
				redirectUris: [
					cursorLocalRedirect,
					cursorCloudRedirect,
					'http://localhost:8787/callback',
				],
				grantRedirectUri: 'http://localhost:8787/callback',
			},
			'cursor-local',
			'Cursor Local',
		],
		[
			{
				clientId: 'grok-bot-client',
				clientName: 'Grok Bot',
				grantRedirectUri: cursorCloudRedirect,
			},
			'grok-bot',
			'Grok Bot',
		],
		[
			{ clientId: 'code-host', clientName: 'Claude Code' },
			'claude-code',
			'Claude Code',
		],
		[
			{
				clientId: 'openmuse-oauth',
				clientName: 'OpenMuse',
				clientUri: 'https://openmuse.example/',
			},
			'openmuse',
			'OpenMuse',
		],
		[
			{
				clientId: 'muse-code-oauth',
				clientName: 'Muse Code',
				grantRedirectUri: 'https://dev.meta.ai/oauth/callback',
			},
			'muse',
			'Muse',
		],
		[
			{
				clientId: 'https://dev.meta.ai/oauth/client.json',
				grantRedirectUri: 'https://dev.meta.ai/oauth/callback',
			},
			'muse',
			'Muse',
		],
		[
			{
				clientId: 'https://muse.ai/oauth/client.json',
				grantRedirectUri: 'https://muse.ai/oauth/callback',
			},
			null,
			'muse.ai',
		],
		[
			{
				clientId: 'https://meta.ai/oauth/client.json',
				grantRedirectUri: 'https://www.meta.ai/oauth/callback',
			},
			null,
			'meta.ai',
		],
		[
			{
				clientId: 'https://unknown.example/oauth/client.json',
				clientName: 'Acme Agent',
			},
			null,
			'Acme Agent',
		],
		[
			{
				clientId:
					'https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json',
				clientUri: 'https://hermes-agent.nousresearch.com',
			},
			'hermes',
			'Hermes Agent',
		],
		[
			{
				clientId:
					'https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json',
			},
			'hermes',
			'Hermes Agent',
		],
		[
			{
				clientId:
					'https://nousresearch.github.io/other-project/client-metadata.json',
			},
			null,
			'nousresearch.github.io',
		],
		[
			{ clientId: 'https://unknown.example/oauth/client.json' },
			null,
			'unknown.example',
		],
		[
			{ clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz' },
			null,
			'opaque-c…',
		],
	]
	expect(
		inbound.map(([input]) => [input, labelInboundMcpClient(input)]),
	).toEqual(inbound.map(([input, kind, label]) => [input, { kind, label }]))

	const names: Array<[string | null, string | null, string]> = [
		['Cursor', 'cursor', 'Cursor'],
		['Claude Code', 'claude-code', 'Claude Code'],
		[null, null, 'Unknown'],
		['Muse Code', 'muse', 'Muse'],
		['Muse', 'muse', 'Muse'],
		['muse-code', 'muse', 'Muse'],
		['OpenMuse', 'openmuse', 'OpenMuse'],
		['openmuse', 'openmuse', 'OpenMuse'],
		['Wajo', 'wajo', 'Wajo'],
		['Cue', 'cue', 'Cue'],
		['Dots', 'dots', 'Dots'],
		['Hermes Agent', 'hermes', 'Hermes Agent'],
		['hermes-agent', 'hermes', 'Hermes Agent'],
		// Bare `hermes` must not classify unrelated clients (CodeRabbit).
		['Hermes Metrics', null, 'Hermes Metrics'],
		['hermes', null, 'hermes'],
	]
	expect(names.map(([name]) => [name, classifyMcpClientName(name)])).toEqual(
		names.map(([name, kind, label]) => [name, { kind, label }]),
	)

	expect(
		truncateClientIdLabel('opaque-client-id-abcdefghijklmnopqrstuvwxyz'),
	).toBe('opaque-c…')
	const connectionLabels: Array<[string, string]> = [
		['https://chatgpt.com/oauth/vG3/client.json', 'chatgpt.com · vG3'],
		[
			'https://chatgpt.com/oauth/vG4-MLZWUV83/client.json',
			'chatgpt.com · vG4-MLZWUV83',
		],
		[
			'https://chatgpt.com/oauth/vG4-MLZWUV84/client.json',
			'chatgpt.com · vG4-MLZWUV84',
		],
		['https://chatgpt.com/oauth/vG4/client.json', 'chatgpt.com · vG4'],
		['cursor-old', 'cursor-o…'],
	]
	expect(
		connectionLabels.map(([id]) => [id, connectedAgentConnectionLabel(id)]),
	).toEqual(connectionLabels)
})

test('grant createdAt unix seconds become an ISO timestamp', () => {
	expect(oauthGrantCreatedAtIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
	expect(oauthGrantCreatedAtIso(1_700_000_000_000)).toBe(
		'2023-11-14T22:13:20.000Z',
	)
	expect(oauthGrantCreatedAtIso(undefined)).toBeNull()
	expect(oauthGrantCreatedAtIso(Number.NaN)).toBeNull()
})

test('connected agents group by display name and sort by last-used, then newest-first at group and member level', () => {
	expect(latestConnectedAt([null, undefined, ''])).toBeNull()
	expect(
		latestConnectedAt([
			'2023-11-14T22:13:20.000Z',
			null,
			'2024-01-01T00:00:00.000Z',
		]),
	).toBe('2024-01-01T00:00:00.000Z')

	const olderCursor = agent(
		'cursor-old',
		'Cursor',
		'cursor',
		'2024-01-01T00:00:00.000Z',
	)
	const newerCursor = agent(
		'cursor-new',
		'Cursor',
		'cursor',
		'2024-06-01T00:00:00.000Z',
	)
	const chatgpt = agent(
		'https://chatgpt.com/oauth/client.json',
		'ChatGPT.com',
		'chatgpt',
		'2024-03-01T00:00:00.000Z',
	)
	const unknown = agent(
		'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
		'Acme Agent',
		null,
		'2024-05-01T00:00:00.000Z',
	)
	const undated = agent('undated', 'Acme Agent', null, null)

	const groups = groupConnectedAgents([
		olderCursor,
		chatgpt,
		undated,
		newerCursor,
		unknown,
	])
	expect(groups).toMatchObject([
		{
			label: 'Cursor',
			kind: 'cursor',
			icon: 'cursor',
			connectedAt: '2024-06-01T00:00:00.000Z',
			lastUsedAt: null,
			members: [newerCursor, olderCursor],
		},
		{
			label: 'Acme Agent',
			kind: null,
			icon: null,
			connectedAt: '2024-05-01T00:00:00.000Z',
			lastUsedAt: null,
			members: [unknown, undated],
		},
		{
			label: 'ChatGPT.com',
			kind: 'chatgpt',
			icon: 'chatgpt',
			connectedAt: '2024-03-01T00:00:00.000Z',
			lastUsedAt: null,
			members: [chatgpt],
		},
	])

	// Last-used sorts first so stale hosts drop below the active one.
	const usedGroups = groupConnectedAgents([
		agent('chatgpt-idle', 'ChatGPT.com', 'chatgpt', '2024-07-01T00:00:00.000Z'),
		agent(
			'cursor-stale',
			'Cursor',
			'cursor',
			'2024-06-01T00:00:00.000Z',
			'2024-06-02T00:00:00.000Z',
		),
		agent(
			'cursor-active',
			'Cursor',
			'cursor',
			'2024-01-01T00:00:00.000Z',
			'2024-08-01T00:00:00.000Z',
		),
	])
	expect(
		usedGroups.map((group) => [
			group.label,
			group.lastUsedAt,
			group.members.map((member) => member.clientId),
		]),
	).toEqual([
		['Cursor', '2024-08-01T00:00:00.000Z', ['cursor-active', 'cursor-stale']],
		['ChatGPT.com', null, ['chatgpt-idle']],
	])
})

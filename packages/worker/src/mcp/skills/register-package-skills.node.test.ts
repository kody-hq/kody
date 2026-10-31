import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildPackageSkillsIndex,
	collectPackageSkills,
} from '#worker/package-registry/package-skills.ts'

const mocks = vi.hoisted(() => ({
	resolveCallerFeatureFlags: vi.fn(),
	loadSource: vi.fn(),
	listOwn: vi.fn(),
	recordRead: vi.fn(),
}))

vi.mock('#worker/package-registry/skill-read-events.ts', async (original) => ({
	...(await original<
		typeof import('#worker/package-registry/skill-read-events.ts')
	>()),
	recordSkillRead: mocks.recordRead,
}))
vi.mock('#mcp/capabilities/access-control.ts', () => ({
	resolveCallerFeatureFlags: (...args: Array<unknown>) =>
		mocks.resolveCallerFeatureFlags(...args),
}))
vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mocks.listOwn(...args),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIds: async (_db: unknown, ids: Array<string>) =>
		ids.map((id) => ({ id, published_commit: 'commit-1' })),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mocks.loadSource(...args),
}))

const kvStore = new Map<string, string>()
const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: {
		get: async (key: string) => {
			const value = kvStore.get(key)
			return value === undefined ? null : JSON.parse(value)
		},
		put: async (key: string, value: string) => {
			kvStore.set(key, value)
		},
	},
} as unknown as Env

const { registerPackageSkillsExtensionWhenEnabled } =
	await import('./register-package-skills.ts')
const { buildPackageSkillsIndexKey } =
	await import('#worker/package-registry/skills-index-cache.ts')

const skillMd =
	'---\nname: ship-it\ndescription: Ship the thing.\n---\n\nBody\n'
const files = { 'skills/ship-it/SKILL.md': skillMd }
const skillUri = 'skill://owner/ship/ship-it/SKILL.md'

const signedInCaller = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://kody.example',
	user: {
		userId: personIdFromStored('user-1'),
		email: 'a@example.com',
		displayName: 'A',
	},
})

function envelope(extensions?: Record<string, unknown>) {
	return {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientCapabilities': extensions
			? { extensions }
			: {},
		'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
	}
}

async function callModern(input: {
	method: string
	params?: Record<string, unknown>
	extensions?: Record<string, unknown>
	callerContext?: ReturnType<typeof createMcpCallerContext>
}) {
	const body = {
		jsonrpc: '2.0',
		id: 1,
		method: input.method,
		params: { ...input.params, _meta: envelope(input.extensions) },
	}
	const request = new Request('https://kody.example/mcp', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': input.method,
			...(input.method === 'resources/read' &&
			typeof input.params?.['uri'] === 'string'
				? { 'Mcp-Name': input.params['uri'] }
				: {}),
		},
		body: JSON.stringify(body),
	})
	const callerContext = input.callerContext ?? signedInCaller
	const handler = createMcpHandler(
		async () => {
			const server = new McpServer(
				{ name: 'kody-mcp', version: '1.0.0' },
				{ jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
			)
			await registerPackageSkillsExtensionWhenEnabled({
				server,
				env,
				callerContext,
				parsedBody: body,
			})
			return server
		},
		{ legacy: 'reject' },
	)
	const response = await handler.fetch(request, { parsedBody: body })
	return (await response.json()) as {
		result?: Record<string, unknown>
		error?: { code: number; message: string }
	}
}

const supported = { 'io.modelcontextprotocol/skills': {} }

beforeEach(async () => {
	kvStore.clear()
	for (const mock of Object.values(mocks)) mock.mockReset()
	mocks.resolveCallerFeatureFlags.mockResolvedValue({
		'mcp-skills-extension': true,
	})
	const record = {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		name: 'ship',
		kodyId: '@owner/ship',
		sourceId: 'source-1',
		hasSkills: true,
		hidden: false,
	}
	mocks.listOwn.mockResolvedValue([record])
	mocks.loadSource.mockResolvedValue({
		files,
		manifest: { kody: { id: '@owner/ship' } },
	})
	const index = buildPackageSkillsIndex({
		packageId: 'pkg-1',
		kodyId: '@owner/ship',
		publishedCommit: 'commit-1',
		skills: await collectPackageSkills({ files, kodyId: '@owner/ship' }),
	})
	kvStore.set(
		buildPackageSkillsIndexKey({
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
		}),
		JSON.stringify(index),
	)
})

test('server/discover advertises the extension and resources when flag and client support are on', async () => {
	const response = await callModern({
		method: 'server/discover',
		extensions: supported,
	})
	expect(response.result?.['capabilities']).toMatchObject({
		resources: {},
		extensions: { 'io.modelcontextprotocol/skills': {} },
	})
})

test('server/discover advertises nothing when the client does not declare the extension', async () => {
	const response = await callModern({ method: 'server/discover' })
	expect(response.result?.['capabilities']).not.toHaveProperty('extensions')
	expect(response.result?.['capabilities']).not.toHaveProperty('resources')
	expect(mocks.resolveCallerFeatureFlags).not.toHaveBeenCalled()
})

test('server/discover advertises nothing when the flag is off for the caller', async () => {
	mocks.resolveCallerFeatureFlags.mockResolvedValue({
		'mcp-skills-extension': false,
	})
	const response = await callModern({
		method: 'server/discover',
		extensions: supported,
	})
	expect(response.result?.['capabilities']).not.toHaveProperty('extensions')
	const list = await callModern({
		method: 'skills/list',
		extensions: supported,
	})
	expect(list.error?.code).toBe(-32601)
})

test('skills/list returns the complete SEP shape', async () => {
	const response = await callModern({
		method: 'skills/list',
		extensions: supported,
	})
	expect(response.result).toMatchObject({
		cacheScope: 'private',
		skills: [
			{
				uri: skillUri,
				frontmatter: { name: 'ship-it', description: 'Ship the thing.' },
				resources: [
					{
						uri: skillUri,
						digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
						size: new TextEncoder().encode(skillMd).byteLength,
					},
				],
			},
		],
	})
})

test('skills/get returns the skill and rejects unknown URIs with -32602', async () => {
	const found = await callModern({
		method: 'skills/get',
		params: { uri: skillUri },
		extensions: supported,
	})
	expect(found.result).toMatchObject({
		cacheScope: 'private',
		skill: { uri: skillUri },
	})

	const unknown = await callModern({
		method: 'skills/get',
		params: { uri: 'skill://owner/ship/missing/SKILL.md' },
		extensions: supported,
	})
	expect(unknown.error?.code).toBe(-32602)

	const invalid = await callModern({
		method: 'skills/get',
		params: {},
		extensions: supported,
	})
	expect(invalid.error?.code).toBe(-32602)
})

test('resources/list and resources/read serve skill:// files', async () => {
	const list = await callModern({
		method: 'resources/list',
		extensions: supported,
	})
	expect(list.result?.['resources']).toEqual([
		{
			uri: skillUri,
			name: 'ship-it',
			mimeType: 'text/markdown',
			size: new TextEncoder().encode(skillMd).byteLength,
			description: 'Ship the thing.',
		},
	])

	const read = await callModern({
		method: 'resources/read',
		params: { uri: skillUri },
		extensions: supported,
	})
	expect(mocks.recordRead).toHaveBeenCalledWith(
		expect.objectContaining({
			channel: 'mcp-resource',
			resource: expect.objectContaining({
				kind: 'instructions',
				skillName: 'ship-it',
			}),
		}),
	)
	expect(read.result).toMatchObject({
		contents: [{ uri: skillUri, mimeType: 'text/markdown', text: skillMd }],
	})

	const unknown = await callModern({
		method: 'resources/read',
		params: { uri: 'skill://owner/ship/missing/SKILL.md' },
		extensions: supported,
	})
	expect(unknown.error?.code).toBe(-32602)
})

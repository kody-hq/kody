import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { listMcpEventSources } from './list-events.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mocks.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const env = { APP_DB: {} } as Env
function createCallerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'one@example.com',
			displayName: 'One',
		},
	})
}

function savedPackage(id: string, kodyId: string): SavedPackageRecord {
	return {
		id,
		userId: ownerIdFromStored('user-1'),
		name: `@kentcdodds/${kodyId}`,
		kodyId,
		description: kodyId,
		tags: [],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function manifestWithEmits(kodyId: string, emits: Record<string, unknown>) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: `@kentcdodds/${kodyId}`,
			exports: { '.': './index.ts' },
			kody: { id: kodyId, description: kodyId, emits },
		}),
	})
}

const manifestsBySourceId = new Map([
	[
		'source-pkg-gateway',
		manifestWithEmits('discord-gateway', {
			'@kentcdodds/discord.message.created': {
				description: 'A Discord message was created.',
				mcp: true,
				payloadSchema: {
					type: 'object',
					properties: { messageId: { type: 'string' } },
				},
			},
			'@kentcdodds/discord.internal.tick': {
				description: 'Internal heartbeat.',
			},
			'@kentcdodds/discord.typing': {
				description: 'Someone is typing.',
				mcp: false,
			},
		}),
	],
	[
		'source-pkg-alerts',
		manifestWithEmits('alerts', {
			'@kentcdodds/alerts.fired': {
				description: 'An alert fired.',
				mcp: true,
			},
			'@kentcdodds/discord.message.created': {
				description: 'Shadow descriptor from a later package.',
				mcp: true,
			},
		}),
	],
	[
		'source-pkg-private',
		manifestWithEmits('private-notes', {
			'@kentcdodds/private.note.saved': {
				description: 'A private note was saved.',
				mcp: true,
			},
		}),
	],
])

afterEach(() => {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
})

function arrange() {
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage('pkg-private', 'private-notes'),
		savedPackage('pkg-gateway', 'discord-gateway'),
		savedPackage('pkg-alerts', 'alerts'),
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const manifest = manifestsBySourceId.get(input.sourceId)
			if (!manifest) throw new Error(`unknown source ${input.sourceId}`)
			return { manifest }
		},
	)
	return createCallerContext()
}

test('only mcp: true topics from readable saved packages are listed, sorted by name', async () => {
	const callerContext = arrange()
	const sources = await listMcpEventSources({ env, callerContext })

	expect([...sources.keys()]).toEqual([
		'@kentcdodds/alerts.fired',
		'@kentcdodds/discord.message.created',
		'@kentcdodds/private.note.saved',
	])
	expect(sources.get('@kentcdodds/alerts.fired')).toEqual({
		definition: {
			name: '@kentcdodds/alerts.fired',
			description: 'An alert fired.',
			delivery: ['webhook'],
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			payloadSchema: { type: 'object' },
		},
		packageIds: ['pkg-alerts'],
	})
	// Packages are visited by kodyId, so `alerts` declares the shared topic
	// first and its descriptor wins.
	expect(sources.get('@kentcdodds/discord.message.created')).toMatchObject({
		definition: {
			description: 'Shadow descriptor from a later package.',
			payloadSchema: { type: 'object' },
		},
		packageIds: ['pkg-alerts', 'pkg-gateway'],
	})
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://kody.example.com',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-pkg-gateway',
	})
})

test('an org-bound connection lists the org packages, not the acting person packages', async () => {
	arrange()
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'one@example.com',
			displayName: 'One',
		},
		orgBinding: {
			org: { id: ownerIdFromStored('org-1'), slug: 'acme' },
			role: 'owner',
		},
	})
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === 'org-1'
				? [
						{
							...savedPackage('pkg-alerts', 'alerts'),
							userId: ownerIdFromStored('org-1'),
						},
					]
				: [],
	)
	const sources = await listMcpEventSources({ env, callerContext })
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('org-1'),
	})
	expect([...sources.keys()]).toEqual([
		'@kentcdodds/alerts.fired',
		'@kentcdodds/discord.message.created',
	])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('org-1') }),
	)
})

test('a package whose manifest fails to load is skipped and logged', async () => {
	consoleWarn.mockImplementation(() => {})
	const callerContext = arrange()
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-pkg-alerts') {
				throw new Error('artifact missing')
			}
			return { manifest: manifestsBySourceId.get(input.sourceId) }
		},
	)
	const sources = await listMcpEventSources({ env, callerContext })
	expect([...sources.keys()]).toEqual([
		'@kentcdodds/discord.message.created',
		'@kentcdodds/private.note.saved',
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp-events-manifest-load-failed',
		expect.objectContaining({ packageId: 'pkg-alerts' }),
	)
})

test('listing requires an authenticated user', async () => {
	await expect(
		listMcpEventSources({
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example.com',
			}),
		}),
	).rejects.toThrow(/authenticated user/)
})

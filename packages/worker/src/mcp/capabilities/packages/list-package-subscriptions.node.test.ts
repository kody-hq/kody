import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

const { listPackageSubscriptionsCapability } =
	await import('./list-package-subscriptions.ts')

type Subscriptions = Record<
	string,
	{ handler: string; description?: string; filters?: unknown }
>

function stubPackages(
	packages: Array<{
		id: string
		kodyId: string
		sourceId: string
		subscriptions?: Subscriptions | Error
	}>,
) {
	mockModule.listSavedPackagesByUserId.mockResolvedValue(
		packages.map(({ id, kodyId, sourceId }) => ({
			id,
			userId: ownerIdFromStored('user-1'),
			name: `@kentcdodds/${kodyId}`,
			kodyId,
			description: `${kodyId} package`,
			tags: [],
			searchText: null,
			sourceId,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		})),
	)
	mockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = packages.find((pkg) => pkg.sourceId === input.sourceId)
			if (!match) throw new Error(`Unexpected source ${input.sourceId}`)
			if (match.subscriptions instanceof Error) throw match.subscriptions
			return {
				source: { id: match.sourceId },
				manifest: {
					name: `@kentcdodds/${match.kodyId}`,
					exports: { '.': './src/index.ts' },
					kody: {
						id: match.kodyId,
						description: `${match.kodyId} package`,
						...(match.subscriptions
							? { subscriptions: match.subscriptions }
							: {}),
					},
				},
			}
		},
	)
}

function listSubscriptions(args: { topic?: string } = {}) {
	return listPackageSubscriptionsCapability.handler(args, {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'kody@example.com',
				displayName: 'Kody',
			},
		}),
	})
}

const messageHandler = {
	handler: './src/message.ts',
	description: 'Message handler',
	filters: { channelIds: ['123'] },
}

test('listPackageSubscriptionsCapability filters, sorts, and skips broken manifests', async () => {
	stubPackages([
		{
			id: 'package-1',
			kodyId: 'discord-general-chat',
			sourceId: 'source-1',
			subscriptions: {
				'discord.message.created': messageHandler,
				'discord.reaction.created': { handler: './src/reaction.ts' },
			},
		},
		{ id: 'package-2', kodyId: 'other', sourceId: 'source-2' },
	])
	const filtered = await listSubscriptions({
		topic: 'discord.message.created',
	})
	expect(filtered.subscriptions).toMatchObject([
		{
			package_id: 'package-1',
			topic: 'discord.message.created',
			handler: './src/message.ts',
			filters: { channelIds: ['123'] },
		},
	])

	stubPackages([
		{
			id: 'package-1',
			kodyId: 'z-package',
			sourceId: 'source-1',
			subscriptions: {
				'discord.reaction.created': { handler: './src/reaction.ts' },
			},
		},
		{
			id: 'package-2',
			kodyId: 'a-package',
			sourceId: 'source-2',
			subscriptions: { 'discord.message.created': messageHandler },
		},
	])
	const sorted = await listSubscriptions()
	expect(sorted.subscriptions.map(({ kody_id }) => kody_id)).toEqual([
		'a-package',
		'z-package',
	])

	consoleWarn.mockImplementation(() => {})
	stubPackages([
		{
			id: 'package-1',
			kodyId: 'ok-package',
			sourceId: 'source-ok',
			subscriptions: {
				'discord.message.created': { handler: './src/message.ts' },
			},
		},
		{
			id: 'package-2',
			kodyId: 'bad-package',
			sourceId: 'source-bad',
			subscriptions: new Error('manifest unavailable'),
		},
	])
	const afterFailure = await listSubscriptions()
	expect(afterFailure.subscriptions.map(({ kody_id }) => kody_id)).toEqual([
		'ok-package',
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to load package manifest for subscriptions',
		expect.objectContaining({ sourceId: 'source-bad', packageId: 'package-2' }),
	)
})

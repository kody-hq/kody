import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as SecretsService from '#mcp/secrets/service.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageWithCommunityProvenanceById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	listPackageSecretsByPackageIds: vi.fn<
		typeof SecretsService.listPackageSecretsByPackageIds
	>(async () => new Map()),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageWithCommunityProvenanceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listPackageSecretsByPackageIds: (
		...args: Parameters<typeof SecretsService.listPackageSecretsByPackageIds>
	) => mockModule.listPackageSecretsByPackageIds(...args),
}))

const { getPackageCapability } = await import('./get-package.ts')

function getPackage(
	args: Record<string, unknown> = {},
	owner?: { ownerUserId: string; ownerScope: string; ownerEmail: string },
) {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: ownerIdFromStored('user-1'),
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'user-1',
		...owner,
	})
	return getPackageCapability.handler(
		{ package_id: 'package-1', ...args },
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'kody@example.com',
					displayName: 'Kody',
					username: 'kody',
				},
				...(owner
					? {
							orgBinding: {
								org: {
									id: ownerIdFromStored(owner.ownerUserId),
									slug: owner.ownerScope,
								},
								role: 'owner' as const,
							},
						}
					: {}),
			}),
		},
	)
}

function stubSavedPackage(input?: {
	userId?: string
	name?: string
	kodyId?: string
	hasApp?: boolean
	sourceListingId?: null
	originCommit?: string
	listingPinnedCommit?: string
	forkListingRelation?: 'synced' | 'outdated' | 'ahead'
}) {
	const forked = input?.sourceListingId !== null
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: input?.userId ?? 'user-1',
		name: input?.name ?? '@kentcdodds/discord-gateway',
		kodyId: input?.kodyId ?? 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: input?.hasApp ?? true,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		sourceListingId: forked ? 'listing-1' : null,
		listingCurrent: forked ? true : null,
		listingKodyId: forked ? 'upstream-discord-gateway' : null,
		listingName: forked ? '@kentcdodds/discord-gateway' : null,
		originCommit: forked ? (input?.originCommit ?? 'commit-origin') : null,
		listingPinnedCommit: forked
			? (input?.listingPinnedCommit ?? 'commit-origin')
			: null,
		listingPublishedAt: forked ? '2026-04-20T00:00:00.000Z' : null,
		listingAhead: forked ? false : null,
		forkListingRelation: forked
			? (input?.forkListingRelation ?? 'synced')
			: null,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
}

function stubSource(
	name: string,
	exports: Record<string, unknown>,
	files?: Record<string, string>,
) {
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1', published_commit: null },
		manifest: {
			name,
			exports,
			kody: { id: name.split('/')[1], description: 'Helpers' },
		},
		files,
	})
}

test('getPackageCapability returns export metadata for personal and org-bound owners', async () => {
	stubSavedPackage()
	stubSource(
		'@kentcdodds/discord-gateway',
		{
			'.': './src/index.ts',
			'./post-message': {
				import: './src/post-message.ts',
				types: './src/post-message.ts',
			},
		},
		{},
	)

	const owned = await getPackage()

	expect(owned).toMatchObject({
		package_id: 'package-1',
		kody_id: 'discord-gateway',
		slug: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		has_app: true,
		visibility: 'public',
		source_id: 'source-1',
		published_commit: null,
		source_listing_id: 'listing-1',
		listing_current: true,
		listing_kody_id: 'upstream-discord-gateway',
		listing_ahead: false,
		created_at: '2026-04-25T00:00:00.000Z',
		updated_at: '2026-04-26T00:00:00.000Z',
		exports: [
			{
				subpath: '.',
				import_specifier: 'kody:@kentcdodds/discord-gateway',
				runtime_target: 'src/index.ts',
			},
			{
				subpath: './post-message',
				import_specifier: 'kody:@kentcdodds/discord-gateway/post-message',
				runtime_target: 'src/post-message.ts',
				types_path: 'src/post-message.ts',
			},
		],
	})
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			packageId: 'package-1',
		}),
	)
	expect(mockModule.loadPackageSourceBySourceId).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
	})

	// An org-bound request loads the org's package metadata.
	stubSavedPackage({
		userId: ownerIdFromStored('org-owner'),
		name: '@acme/discord-gateway',
		hasApp: false,
		sourceListingId: null,
	})
	stubSource(
		'@acme/discord-gateway',
		{ './post-message': './src/post-message.ts' },
		{},
	)
	mockModule.resolvePackageOwnerContext.mockClear()

	const orgOwned = await getPackage(
		{},
		{
			ownerUserId: ownerIdFromStored('org-owner'),
			ownerScope: 'acme',
			ownerEmail: 'acme@example.com',
		},
	)

	expect(mockModule.resolvePackageOwnerContext).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			user: expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
		}),
	)
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('org-owner'),
			packageId: 'package-1',
		}),
	)
	expect(mockModule.loadPackageSourceBySourceId).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('org-owner') }),
	)
	expect(orgOwned.exports[0]).toMatchObject({
		subpath: './post-message',
		import_specifier: 'kody:@acme/discord-gateway/post-message',
	})
	expect(owned.package_secrets).toEqual([])
	expect(orgOwned.package_secrets).toEqual([])
})

test('getPackageCapability includes package-scoped secret metadata as FYI', async () => {
	stubSavedPackage()
	stubSource('@kentcdodds/discord-gateway', { '.': './src/index.ts' }, {})
	mockModule.listPackageSecretsByPackageIds.mockResolvedValueOnce(
		new Map([
			[
				'package-1',
				[
					{
						name: 'discordBotToken',
						scope: 'package',
						description: 'Bot token for this package',
						packageId: 'package-1',
						allowedHosts: ['discord.com'],
						allowedPackages: [],
						createdAt: '2026-04-25T00:00:00.000Z',
						updatedAt: '2026-04-26T00:00:00.000Z',
						expiresAt: null,
						ttlMs: null,
						placement: null,
					},
				],
			],
		]),
	)

	const result = await getPackage()

	expect(result.package_secrets).toEqual([
		{
			name: 'discordBotToken',
			scope: 'package',
			description: 'Bot token for this package',
			package_id: 'package-1',
			allowed_hosts: ['discord.com'],
			allowed_packages: [],
			created_at: '2026-04-25T00:00:00.000Z',
			updated_at: '2026-04-26T00:00:00.000Z',
			expires_at: null,
			ttl_ms: null,
			placement: null,
		},
	])
	expect(result.package_secrets[0]).not.toHaveProperty('value')
	expect(mockModule.listPackageSecretsByPackageIds).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		userId: ownerIdFromStored('user-1'),
		packageIds: ['package-1'],
	})
})

test('getPackageCapability omits fork-ahead from the agent payload', async () => {
	stubSavedPackage({
		originCommit: 'fork-tip',
		listingPinnedCommit: 'listing-pin',
		forkListingRelation: 'ahead',
	})
	stubSource('@kentcdodds/discord-gateway', { '.': './src/index.ts' }, {})

	const result = await getPackage()

	expect(result.listing_ahead).toBe(false)
	for (const key of ['forkListingRelation', 'fork_listing_relation']) {
		expect(result).not.toHaveProperty(key)
	}
	expect(JSON.stringify(result)).not.toMatch(/fork.?ahead/i)
})

test('getPackageCapability projects export contracts from source and leaves them empty without projectable text', async () => {
	const listEventsExport = {
		'./list-events': {
			import: './src/list-events.ts',
			types: './src/list-events.d.ts',
		},
	}
	const listEventsDefinition =
		'export declare function listEvents(calendarId: string): Promise<string[]>'
	const emptyContract = {
		description: null,
		type_definition: null,
		functions: [],
		referenced_types: [],
	}
	stubSavedPackage({
		name: '@kentcdodds/calendar',
		kodyId: 'calendar',
		sourceListingId: null,
	})
	stubSource('@kentcdodds/calendar', listEventsExport, {
		'src/list-events.ts':
			'export const ignored = "types file should be preferred"',
		'src/list-events.d.ts': `/**
 * List upcoming calendar events.
 */
${listEventsDefinition}
`,
	})

	expect((await getPackage()).exports).toEqual([
		expect.objectContaining({
			subpath: './list-events',
			import_specifier: 'kody:@kentcdodds/calendar/list-events',
			runtime_target: 'src/list-events.ts',
			types_path: 'src/list-events.d.ts',
			description: 'List upcoming calendar events.',
			type_definition: listEventsDefinition,
			functions: [
				{
					name: 'listEvents',
					description: 'List upcoming calendar events.',
					type_definition: listEventsDefinition,
				},
			],
			referenced_types: [],
		}),
	])

	stubSavedPackage({
		name: '@kentcdodds/google',
		kodyId: 'google',
		sourceListingId: null,
	})
	stubSource(
		'@kentcdodds/google',
		{ './calendar': './src/calendar.ts' },
		{
			'src/calendar.ts': `export type CalendarEventsParams = { account: string; calendarId?: string }
export type CalendarEventsAcrossCalendarsParams = CalendarEventsParams & { calendarMaxResults?: number }

export async function listEvents(params: CalendarEventsParams): Promise<{ items: Array<unknown> }> {
	return { items: [] }
}

export async function listEventsAcrossCalendars(
	params: CalendarEventsAcrossCalendarsParams,
): Promise<{ items: Array<unknown>; calendars: Array<unknown>; failures: Array<string> }> {
	return { items: [], calendars: [], failures: [] }
}

/**
 * Return the Google Calendar helper namespace.
 */
export default function calendar() {
	return { listEvents, listEventsAcrossCalendars }
}
`,
		},
	)

	const [calendarExport] = (await getPackage()).exports
	expect(calendarExport?.functions.map((fn) => fn.name)).toEqual([
		'listEvents',
		'listEventsAcrossCalendars',
		'default',
	])
	expect(calendarExport?.referenced_types.map((type) => type.name)).toEqual([
		'CalendarEventsParams',
		'CalendarEventsAcrossCalendarsParams',
	])
	expect(calendarExport?.referenced_types[0]?.definition).toContain(
		'account: string',
	)

	// Same path search hydration avoids: projection without file text
	// cannot derive callable contracts even when the manifest lists types.
	stubSavedPackage({
		name: '@kentcdodds/calendar',
		kodyId: 'calendar',
		sourceListingId: null,
	})
	stubSource('@kentcdodds/calendar', listEventsExport, undefined)
	expect((await getPackage()).exports).toEqual([
		expect.objectContaining({
			subpath: './list-events',
			runtime_target: 'src/list-events.ts',
			types_path: 'src/list-events.d.ts',
			...emptyContract,
		}),
	])

	stubSavedPackage({
		name: '@kentcdodds/untyped-helpers',
		kodyId: 'untyped-helpers',
		sourceListingId: null,
	})
	// Non-function exports are intentionally ignored by the projector.
	stubSource(
		'@kentcdodds/untyped-helpers',
		{ '.': './src/index.ts' },
		{ 'src/index.ts': "export const VERSION = '1.0.0'\n" },
	)
	expect((await getPackage()).exports).toEqual([
		expect.objectContaining({
			subpath: '.',
			runtime_target: 'src/index.ts',
			...emptyContract,
		}),
	])
})

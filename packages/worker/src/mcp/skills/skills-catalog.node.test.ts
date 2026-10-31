import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	ProtocolError,
	ResourceNotFoundError,
} from '@modelcontextprotocol/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	buildPackageSkillsIndex,
	collectPackageSkills,
	type PackageSkillsIndex,
} from '#worker/package-registry/package-skills.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

const mocks = vi.hoisted(() => ({
	listOwn: vi.fn(),
	listEntitySourcesByIds: vi.fn(),
	readIndex: vi.fn(),
	writeIndex: vi.fn(),
	loadSource: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesWithCommunityProvenanceByUserId: (...args: Array<unknown>) =>
		mocks.listOwn(...args),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIds: (...args: Array<unknown>) =>
		mocks.listEntitySourcesByIds(...args),
}))
vi.mock('#worker/package-registry/skills-index-cache.ts', () => ({
	readPackageSkillsIndex: (...args: Array<unknown>) => mocks.readIndex(...args),
	writePackageSkillsIndex: (...args: Array<unknown>) =>
		mocks.writeIndex(...args),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mocks.loadSource(...args),
}))

const {
	buildSkillsGetResult,
	buildSkillsListResult,
	loadCallerSkillsCatalog,
	readCatalogSkillResource,
} = await import('./skills-catalog.ts')

const env = { APP_DB: {} } as unknown as Env
const callerContext = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://kody.example',
	user: {
		userId: personIdFromStored('user-1'),
		email: 'a@example.com',
		displayName: 'A',
	},
})

const skillMd = [
	'---',
	'name: ship-it',
	'description: Ship the thing.',
	'---',
	'',
	'# Ship it',
].join('\n')
const referenceMd = '# Reference\n'

const packageFiles = {
	'skills/ship-it/SKILL.md': skillMd,
	'skills/ship-it/references/guide.md': referenceMd,
}

function savedPackage(
	overrides: Partial<SavedPackageRecord> = {},
): SavedPackageRecord {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		name: '@owner/ship',
		kodyId: 'ship',
		description: '',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: true,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

async function buildIndex(
	record: SavedPackageRecord,
	publishedCommit = 'commit-1',
	files: Record<string, string> = packageFiles,
): Promise<PackageSkillsIndex> {
	return buildPackageSkillsIndex({
		packageId: record.id,
		kodyId: record.name,
		publishedCommit,
		skills: await collectPackageSkills({ files, kodyId: record.name }),
	})
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset()
	mocks.listOwn.mockResolvedValue([])
	mocks.listEntitySourcesByIds.mockImplementation(
		async (_db: unknown, ids: Array<string>) =>
			ids.map((id) => ({ id, published_commit: 'commit-1' })),
	)
	mocks.readIndex.mockResolvedValue(null)
	mocks.loadSource.mockResolvedValue({
		files: packageFiles,
		manifest: { name: '@owner/ship', kody: { id: 'ship' } },
	})
})

test('anonymous callers get an empty catalog without touching storage', async () => {
	const catalog = await loadCallerSkillsCatalog({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.example',
		}),
	})
	expect(catalog).toEqual([])
	expect(mocks.listOwn).not.toHaveBeenCalled()
})

test('an org-bound connection lists the org skills, not the acting person skills', async () => {
	mocks.listOwn.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === 'org-1'
				? [savedPackage({ userId: ownerIdFromStored('org-1') })]
				: [
						savedPackage({
							id: 'pkg-person',
							userId: ownerIdFromStored('user-1'),
						}),
					],
	)
	mocks.readIndex.mockImplementation(async () => buildIndex(savedPackage()))
	const catalog = await loadCallerSkillsCatalog({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.example',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'a@example.com',
				displayName: 'A',
			},
			orgBinding: {
				org: { id: ownerIdFromStored('org-1'), slug: 'acme' },
				role: 'owner',
			},
		}),
	})
	expect(mocks.listOwn).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('org-1'),
	})
	expect(catalog).toHaveLength(1)
})

test('lists the caller org skills from KV indexes, skipping hidden and skill-less packages', async () => {
	const own = savedPackage()
	const hidden = savedPackage({ id: 'pkg-hidden', sourceId: 'source-hidden' })
	hidden.hidden = true
	const noSkills = savedPackage({
		id: 'pkg-none',
		sourceId: 'source-none',
		hasSkills: false,
	})
	const second = savedPackage({
		id: 'pkg-2',
		name: '@owner/second',
		kodyId: 'second',
		sourceId: 'source-2',
	})
	mocks.listOwn.mockResolvedValue([own, hidden, noSkills, second])
	const indexes = new Map<string, PackageSkillsIndex>()
	for (const record of [own, second]) {
		indexes.set(record.id, await buildIndex(record))
	}
	mocks.readIndex.mockImplementation(
		async (input: { packageId: string }) =>
			indexes.get(input.packageId) ?? null,
	)

	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	expect(catalog.map((entry) => entry.packageId)).toEqual(['pkg-1', 'pkg-2'])
	expect(mocks.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [
		'source-1',
		'source-2',
	])
	expect(mocks.readIndex).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-2',
		publishedCommit: 'commit-1',
	})
	expect(mocks.loadSource).not.toHaveBeenCalled()

	const listed = buildSkillsListResult(catalog)
	expect(listed).toMatchObject({
		resultType: 'complete',
		ttlMs: 300_000,
		cacheScope: 'private',
	})
	expect(listed.skills.map((skill) => skill.uri)).toEqual([
		'skill://owner/ship/ship-it/SKILL.md',
		'skill://owner/second/ship-it/SKILL.md',
	])
	expect(listed.skills[0]).toEqual({
		uri: 'skill://owner/ship/ship-it/SKILL.md',
		frontmatter: { name: 'ship-it', description: 'Ship the thing.' },
		resources: [
			{
				uri: 'skill://owner/ship/ship-it/SKILL.md',
				digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				size: new TextEncoder().encode(skillMd).byteLength,
			},
			{
				uri: 'skill://owner/ship/ship-it/references/guide.md',
				digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				size: referenceMd.length,
			},
		],
	})
})

test('rebuilds and persists a missing index for packages published before the flag', async () => {
	mocks.listOwn.mockResolvedValue([savedPackage()])

	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	expect(mocks.loadSource).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://kody.example',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
	})
	expect(mocks.writeIndex).toHaveBeenCalledTimes(1)
	expect(mocks.writeIndex.mock.calls[0]![0]).toMatchObject({
		userId: ownerIdFromStored('user-1'),
		index: { packageId: 'pkg-1', publishedCommit: 'commit-1' },
	})
	expect(buildSkillsListResult(catalog).skills).toHaveLength(1)
})

test('skips a package when its lazy rebuild fails instead of blanking the catalog', async () => {
	mocks.listOwn.mockResolvedValue([savedPackage()])
	mocks.loadSource.mockRejectedValue(new Error('snapshot gone'))
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const catalog = await loadCallerSkillsCatalog({ env, callerContext })
		expect(catalog).toEqual([])
		expect(consoleError).toHaveBeenCalledWith(
			'package-skills-catalog-load-failed',
			'pkg-1',
			expect.stringContaining('snapshot gone'),
		)
	} finally {
		consoleError.mockRestore()
	}
})

test('skills/get returns one skill and rejects unknown URIs with -32602', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	const found = buildSkillsGetResult(
		catalog,
		'skill://owner/ship/ship-it/SKILL.md',
	)
	expect(found).toMatchObject({
		resultType: 'complete',
		skill: { uri: 'skill://owner/ship/ship-it/SKILL.md' },
		ttlMs: 300_000,
		cacheScope: 'private',
	})

	const failure = (() => {
		try {
			buildSkillsGetResult(catalog, 'skill://owner/ship/other/SKILL.md')
		} catch (error) {
			return error
		}
		return null
	})()
	expect(failure).toBeInstanceOf(ProtocolError)
	expect(failure).toMatchObject({ code: -32602 })
})

test('resources/read returns verified text content and rejects unknown URIs', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	const result = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/references/guide.md',
	})
	expect(result).toEqual({
		contents: [
			{
				uri: 'skill://owner/ship/ship-it/references/guide.md',
				mimeType: 'text/markdown',
				text: referenceMd,
			},
		],
	})

	const missing = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/nope.md',
	}).catch((error: unknown) => error)
	expect(missing).toBeInstanceOf(ResourceNotFoundError)
	expect(missing).toMatchObject({ code: -32602 })
})

test('skips packages whose skills index cannot load without failing the catalog', async () => {
	const own = savedPackage()
	const broken = savedPackage({
		id: 'pkg-broken',
		name: '@owner/broken',
		kodyId: 'broken',
		sourceId: 'source-broken',
	})
	mocks.listOwn.mockResolvedValue([own, broken])
	mocks.readIndex.mockImplementation(async (input: { packageId: string }) => {
		if (input.packageId === broken.id) {
			throw new Error('kv unavailable')
		}
		return buildIndex(own)
	})
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const catalog = await loadCallerSkillsCatalog({ env, callerContext })
		expect(catalog.map((entry) => entry.packageId)).toEqual(['pkg-1'])
		expect(consoleError).toHaveBeenCalledWith(
			'package-skills-catalog-load-failed',
			'pkg-broken',
			'kv unavailable',
		)
	} finally {
		consoleError.mockRestore()
	}
})

test('resources/read returns binary skill assets as base64 blobs', async () => {
	const pngMagic = String.fromCharCode(
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
	)
	const files = {
		...packageFiles,
		'skills/ship-it/assets/logo.png': pngMagic,
	}
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own, 'commit-1', files))
	mocks.loadSource.mockResolvedValue({
		files,
		manifest: { name: '@owner/ship', kody: { id: 'ship' } },
	})
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })

	const result = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/assets/logo.png',
	})
	expect(result).toEqual({
		contents: [
			{
				uri: 'skill://owner/ship/ship-it/assets/logo.png',
				mimeType: 'image/png',
				blob: btoa(pngMagic),
			},
		],
	})
})

test('resources/read fails when the snapshot no longer matches the indexed digest', async () => {
	const own = savedPackage()
	mocks.listOwn.mockResolvedValue([own])
	mocks.readIndex.mockResolvedValue(await buildIndex(own))
	const catalog = await loadCallerSkillsCatalog({ env, callerContext })
	mocks.loadSource.mockResolvedValue({
		files: {
			...packageFiles,
			'skills/ship-it/references/guide.md': '# Tampered\n',
		},
		manifest: { kody: { id: '@owner/ship' } },
	})

	const failure = await readCatalogSkillResource({
		env,
		callerContext,
		catalog,
		uri: 'skill://owner/ship/ship-it/references/guide.md',
	}).catch((error: unknown) => error)

	expect(failure).toMatchObject({
		code: -32603,
		message: expect.stringContaining('digest'),
	})
})

test('human inventories report index failures instead of silently dropping packages', async () => {
	mocks.listOwn.mockResolvedValue([savedPackage()])
	mocks.readIndex.mockRejectedValue(new Error('Index unavailable'))
	await expect(
		loadCallerSkillsCatalog({ env, callerContext, failOnError: true }),
	).rejects.toThrow('Index unavailable')
})

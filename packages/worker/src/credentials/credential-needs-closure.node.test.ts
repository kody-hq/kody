import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

const mocks = vi.hoisted(() => ({
	kv: new Map<string, unknown>(),
	packages: new Map<string, { userId: string; sourceId: string }>(),
	sources: new Map<
		string,
		{
			id: string
			user_id: string
			published_commit: string | null
			manifest_path?: string
			source_root?: string
		}
	>(),
	manifests: new Map<string, unknown>(),
	snapshots: new Map<string, Record<string, string>>(),
	supplierFlag: vi.fn(async () => false),
}))

vi.mock('./credential-suppliers-flag.ts', () => ({
	isPackageCredentialSuppliersEnabled: mocks.supplierFlag,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
	}) => mocks.kv.get(`${input.sourceId}:${input.publishedCommit}`) ?? null,
	writePublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
		needs: unknown
	}) => {
		mocks.kv.set(`${input.sourceId}:${input.publishedCommit}`, input.needs)
	},
	readPublishedSourceSnapshot: async (input: {
		sourceId: string
		publishedCommit: string
	}) => {
		const files = mocks.snapshots.get(
			`${input.sourceId}:${input.publishedCommit}`,
		)
		return files ? { files } : null
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByName: async (
		_db: unknown,
		input: { userId: string; name: string },
	) => {
		const row = mocks.packages.get(input.name)
		return row && row.userId === input.userId ? row : null
	},
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: async (_db: unknown, id: string) =>
		mocks.sources.get(id) ?? null,
	listEntitySourcesByIds: async (_db: unknown, ids: ReadonlyArray<string>) =>
		ids.flatMap((id) => {
			const row = mocks.sources.get(id)
			return row ? [row] : []
		}),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: async (input: { sourceId: string }) => ({
		manifest: mocks.manifests.get(input.sourceId),
	}),
}))

const {
	computeCredentialNeedsClosure,
	loadPublishedCredentialNeeds,
	packageSourceFiles,
	storePublishedCredentialNeeds,
} = await import('./credential-needs-closure.ts')

const env = { APP_DB: {} } as unknown as Env

function manifest(
	name: string,
	credentials: AuthoredPackageJson['kody']['credentials'],
) {
	return {
		name,
		exports: { '.': './index.ts' },
		kody: { description: 'x', credentials },
	} as unknown as AuthoredPackageJson
}

function addPackage(input: {
	name: string
	sourceId: string
	commit: string
	credentials?: AuthoredPackageJson['kody']['credentials']
	storedNeeds?: unknown
	files?: Record<string, string>
}) {
	mocks.packages.set(input.name, { userId: 'org-1', sourceId: input.sourceId })
	mocks.sources.set(input.sourceId, {
		id: input.sourceId,
		user_id: 'org-1',
		published_commit: input.commit,
		manifest_path: 'package.json',
		source_root: '/',
	})
	mocks.manifests.set(input.sourceId, manifest(input.name, input.credentials))
	if (input.storedNeeds !== undefined) {
		mocks.kv.set(`${input.sourceId}:${input.commit}`, input.storedNeeds)
	}
	if (input.files) {
		mocks.snapshots.set(`${input.sourceId}:${input.commit}`, input.files)
	}
}

beforeEach(() => {
	mocks.kv.clear()
	mocks.packages.clear()
	mocks.sources.clear()
	mocks.manifests.clear()
	mocks.snapshots.clear()
	mocks.supplierFlag.mockReset()
	mocks.supplierFlag.mockResolvedValue(false)
})

test('publish stores own needs plus each imported package closure, and reads it back', async () => {
	addPackage({
		name: '@acme/triage',
		sourceId: 'src-triage',
		commit: 'c1',
		storedNeeds: [
			{
				key: 'linear',
				kind: 'mcp',
				provider: 'linear',
				description: 'Linear.',
				multiple: false,
				from: '@acme/linear-tools',
			},
		],
	})
	addPackage({
		name: '@acme/notify',
		sourceId: 'src-notify',
		commit: 'c2',
		// Published before closures were stored: its own needs stand in.
		credentials: { resend: { kind: 'secret', description: 'Email.' } },
	})
	const files = {
		'index.ts': [
			"import triage from 'kody:@acme/triage'",
			"import notify from 'kody:@acme/notify/send'",
			"import self from 'kody:@acme/app/other'",
			"import missing from 'kody:@acme/missing'",
			'export default () => [triage, notify, self, missing]',
		].join('\n'),
	}
	await storePublishedCredentialNeeds({
		env,
		source: {
			id: 'src-app',
			user_id: 'org-1',
			entity_kind: 'package',
			manifest_path: 'package.json',
			source_root: '/',
		} as never,
		publishedCommit: 'c3',
		files: {
			...files,
			'package.json': JSON.stringify({
				name: '@acme/app',
				exports: { '.': './index.ts' },
				kody: {
					description: 'App.',
					credentials: { github: { kind: 'oauth', description: 'Repos.' } },
				},
			}),
		},
	})
	const expected = [
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Repos.',
			multiple: false,
		},
		{
			key: 'linear',
			kind: 'mcp',
			provider: 'linear',
			description: 'Linear.',
			multiple: false,
			from: '@acme/linear-tools',
		},
		{
			key: 'resend',
			kind: 'secret',
			provider: 'resend',
			description: 'Email.',
			multiple: false,
			from: '@acme/notify',
		},
	]
	expect(mocks.kv.get('src-app:c3')).toEqual(expected)
	mocks.sources.set('src-app', {
		id: 'src-app',
		user_id: 'org-1',
		published_commit: 'c3',
	})
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-app',
		}),
	).toEqual(expected)
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-2',
			sourceId: 'src-app',
		}),
	).toEqual([])
})

test('pinned closures preserve supplier and required status on readback', async () => {
	mocks.supplierFlag.mockResolvedValue(true)
	addPackage({
		name: '@fixture/dependency',
		sourceId: 'src-dependency',
		commit: 'c1',
		storedNeeds: [
			{
				key: 'calendar',
				provider: 'calendar',
				description: 'Visitor calendar.',
				multiple: false,
				supplier: 'executor',
				required: false,
			},
		],
	})
	addPackage({
		name: '@fixture/root',
		sourceId: 'src-root',
		commit: 'c2',
	})
	await storePublishedCredentialNeeds({
		env,
		source: {
			id: 'src-root',
			user_id: 'org-1',
			entity_kind: 'package',
			manifest_path: 'package.json',
			source_root: '/',
		} as never,
		publishedCommit: 'c2',
		files: {
			'package.json': JSON.stringify({
				name: '@fixture/root',
				exports: { '.': './index.ts' },
				kody: { description: 'Root.' },
			}),
			'index.ts': "import dependency from 'kody:@fixture/dependency'",
		},
	})
	expect(mocks.kv.get('src-root:c2')).toEqual([
		expect.objectContaining({
			key: 'calendar',
			supplier: 'executor',
			required: false,
			from: '@fixture/dependency',
		}),
	])
	await expect(
		loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-root',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			key: 'calendar',
			supplier: 'executor',
			required: false,
			from: '@fixture/dependency',
		}),
	])
	mocks.supplierFlag.mockResolvedValue(false)
	await expect(
		loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-root',
		}),
	).resolves.toEqual([
		{
			key: 'calendar',
			provider: 'calendar',
			description: 'Visitor calendar.',
			multiple: false,
			from: '@fixture/dependency',
		},
	])
})

test('published visitor needs cannot reference publisher-supplied credentials', async () => {
	mocks.supplierFlag.mockResolvedValue(true)
	const packageManifest = {
		...manifest('@fixture/app', {
			database: {
				description: 'Publisher database.',
				supplier: 'publisher',
			},
		}),
		kody: {
			...manifest('@fixture/app', undefined).kody,
			credentials: {
				database: {
					description: 'Publisher database.',
					supplier: 'publisher',
				},
			},
			app: {
				entry: './server.ts',
				visitorNeeds: {
					database: {
						description: 'Read your database.',
						credential: 'database',
					},
				},
			},
		},
	} as unknown as AuthoredPackageJson
	const closure = await computeCredentialNeedsClosure({
		env,
		userId: 'org-1',
		manifest: packageManifest,
		files: { 'index.ts': 'export default {}' },
	})
	expect(closure.conflicts).toContain(
		'kody.app.visitorNeeds.database cannot reference publisher-supplied credential need "database".',
	)
})

test('a dependency that declares the same key with another kind is a conflict', async () => {
	addPackage({
		name: '@acme/gh-pat',
		sourceId: 'src-pat',
		commit: 'c1',
		credentials: { github: { kind: 'secret', description: 'PAT.' } },
	})
	const { conflicts } = await computeCredentialNeedsClosure({
		env,
		userId: 'org-1',
		manifest: manifest('@acme/app', {
			github: { kind: 'oauth', description: 'Repos.' },
		}),
		files: { 'index.ts': "import pat from 'kody:@acme/gh-pat'" },
	})
	expect(conflicts).toHaveLength(1)
})

test('supplierSemanticsEnabled is reused through dependency recursion (KODY-BT)', async () => {
	mocks.supplierFlag.mockResolvedValue(true)
	addPackage({
		name: '@acme/leaf',
		sourceId: 'src-leaf',
		commit: 'c1',
		credentials: { openai: { kind: 'secret', description: 'OpenAI.' } },
	})
	addPackage({
		name: '@acme/mid',
		sourceId: 'src-mid',
		commit: 'c1',
		files: { 'index.ts': "import leaf from 'kody:@acme/leaf'" },
	})
	await computeCredentialNeedsClosure({
		env,
		userId: 'org-1',
		manifest: manifest('@acme/root', undefined),
		files: { 'index.ts': "import mid from 'kody:@acme/mid'" },
		supplierSemanticsEnabled: false,
	})
	expect(mocks.supplierFlag).not.toHaveBeenCalled()
})

test('a publish that stored no closure is computed from its published source', async () => {
	addPackage({
		name: '@acme/connector',
		sourceId: 'src-connector',
		commit: 'c1',
		credentials: { github: { kind: 'oauth', description: 'Repos.' } },
	})
	addPackage({
		name: '@acme/bridge',
		sourceId: 'src-bridge',
		commit: 'c2',
		files: { 'index.ts': "import c from 'kody:@acme/connector'" },
	})
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-bridge',
		}),
	).toEqual([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Repos.',
			multiple: false,
			from: '@acme/connector',
		},
	])
})

test('an import cycle between unstored closures ends', async () => {
	addPackage({
		name: '@acme/a',
		sourceId: 'src-a',
		commit: 'c1',
		credentials: { linear: { kind: 'mcp', description: 'Linear.' } },
		files: { 'index.ts': "import b from 'kody:@acme/b'" },
	})
	addPackage({
		name: '@acme/b',
		sourceId: 'src-b',
		commit: 'c1',
		files: { 'index.ts': "import a from 'kody:@acme/a'" },
	})
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-a',
		}),
	).toEqual([
		{
			key: 'linear',
			kind: 'mcp',
			provider: 'linear',
			description: 'Linear.',
			multiple: false,
		},
	])
})

test('package files come out source-root relative from either publish shape', () => {
	const source = {
		manifest_path: 'packages/demo/package.json',
		source_root: '/packages/demo/',
	}
	expect(
		packageSourceFiles({
			source,
			files: {
				'packages/demo/package.json': '{}',
				'packages/demo/src/index.ts': 'demo',
				'packages/other/src/index.ts': 'other',
			},
		}),
	).toEqual({
		files: { 'package.json': '{}', 'src/index.ts': 'demo' },
		manifestContent: '{}',
	})
	expect(
		packageSourceFiles({
			source,
			files: { 'package.json': '{}', 'src/index.ts': 'demo' },
		}),
	).toEqual({
		files: { 'package.json': '{}', 'src/index.ts': 'demo' },
		manifestContent: '{}',
	})
	expect(
		packageSourceFiles({
			source: { manifest_path: 'package.json', source_root: '/' },
			files: { 'package.json': '{}' },
		}).manifestContent,
	).toBe('{}')
})

test('a nested package stores only its own imports from a repo-relative snapshot', async () => {
	addPackage({
		name: '@acme/connector',
		sourceId: 'src-connector',
		commit: 'c1',
		credentials: { github: { kind: 'oauth', description: 'Repos.' } },
	})
	addPackage({
		name: '@acme/mailer',
		sourceId: 'src-mailer',
		commit: 'c1',
		credentials: { resend: { kind: 'secret', description: 'Email.' } },
	})
	await storePublishedCredentialNeeds({
		env,
		source: {
			id: 'src-demo',
			user_id: 'org-1',
			entity_kind: 'package',
			manifest_path: 'packages/demo/package.json',
			source_root: '/packages/demo/',
		} as never,
		publishedCommit: 'c9',
		files: {
			'packages/demo/package.json': JSON.stringify({
				name: '@acme/demo',
				exports: { '.': './index.ts' },
				kody: { description: 'Demo.' },
			}),
			'packages/demo/index.ts': "import c from 'kody:@acme/connector'",
			'packages/other/index.ts': "import m from 'kody:@acme/mailer'",
		},
	})
	expect(mocks.kv.get('src-demo:c9')).toEqual([
		expect.objectContaining({ key: 'github', from: '@acme/connector' }),
	])
})

test('a dependency lookup failure throws instead of yielding a partial closure', async () => {
	addPackage({
		name: '@acme/connector',
		sourceId: 'src-connector',
		commit: 'c1',
		credentials: { github: { kind: 'oauth', description: 'Repos.' } },
	})
	mocks.manifests.delete('src-connector')
	await expect(
		computeCredentialNeedsClosure({
			env,
			userId: 'org-1',
			manifest: manifest('@acme/app', undefined),
			files: { 'index.ts': "import c from 'kody:@acme/connector'" },
		}),
	).rejects.toThrow()
	await storePublishedCredentialNeeds({
		env,
		source: {
			id: 'src-app',
			user_id: 'org-1',
			entity_kind: 'package',
			manifest_path: 'package.json',
			source_root: '/',
		} as never,
		publishedCommit: 'c3',
		files: {
			'package.json': JSON.stringify({
				name: '@acme/app',
				exports: { '.': './index.ts' },
				kody: { description: 'App.' },
			}),
			'index.ts': "import c from 'kody:@acme/connector'",
		},
	})
	expect(mocks.kv.has('src-app:c3')).toBe(false)
})

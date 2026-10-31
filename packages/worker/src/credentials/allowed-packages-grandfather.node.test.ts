import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	listCandidatePackages: vi.fn(),
	accessKind: vi.fn(),
	loadPackageSourceRowForUser: vi.fn(),
	readPublishedSourceSnapshot: vi.fn(),
	auditBatch: vi.fn(),
}))

vi.mock(
	'#worker/package-runtime/published-importable-artifact-backfill.ts',
	() => ({
		listCandidatePackages: (...args: Array<unknown>) =>
			mocks.listCandidatePackages(...args),
	}),
)
vi.mock('#mcp/secrets/package-access.ts', () => ({
	savedPackageImplicitUserSecretReadAccessKind: (...args: Array<unknown>) =>
		mocks.accessKind(...args),
	resolveSecretPageOrgSlug: vi.fn(),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		mocks.loadPackageSourceRowForUser(...args),
}))
vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readPublishedSourceSnapshot(...args),
}))
vi.mock('#worker/orgs/org-audit.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#worker/orgs/org-audit.ts')>()),
	runAppDbBatchWithOrgAudit: async (input: {
		statements: Array<{ run(): Promise<{ meta?: { changes?: number } }> }>
		onlyIfChanged?: boolean
	}) => {
		let changes = 0
		for (const statement of input.statements) {
			changes = (await statement.run()).meta?.changes ?? 0
		}
		if (!input.onlyIfChanged || changes > 0) mocks.auditBatch(input)
		return { changed: changes > 0 }
	},
}))

const { runAllowedPackagesGrandfather, grantGrandfatheredPackageAccess } =
	await import('./allowed-packages-grandfather.ts')

const owner = ownerIdFromStored('owner-1')

function savedPackage(id: string) {
	return { id, userId: owner, sourceId: `source-${id}`, name: id, kodyId: id }
}

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('b1', '${owner}', 'user', '')`,
	)
	const insert = sqlite.prepare(
		`INSERT INTO secret_entries (bucket_id, id, name, encrypted_value, allowed_packages) VALUES ('b1', ?, ?, 'x', ?)`,
	)
	insert.run('cred-locked', 'LOCKED', JSON.stringify(['pkg-other']))
	insert.run('cred-open', 'OPEN', '[]')
	insert.run('cred-dynamic', 'DYNAMIC', JSON.stringify(['pkg-other']))
	insert.run('cred-allowed', 'ALLOWED', JSON.stringify(['pkg-static']))
	sqlite
		.prepare(
			`INSERT INTO credential_allowed_packages_would_block (day, owner_id, credential_id, package_id, access_kind, first_seen_at, last_seen_at, observations) VALUES (?, ?, ?, ?, 'self_authored', ?, ?, ?)`,
		)
		.run(
			'2026-10-24',
			owner,
			'cred-dynamic',
			'pkg-dynamic',
			'2026-10-24T01:00:00.000Z',
			'2026-10-24T02:00:00.000Z',
			3,
		)
	return { sqlite, db: createD1FromSqlite(sqlite, { maxBindings: 100 }) }
}

const files: Record<string, Record<string, string>> = {
	'pkg-static': {
		'package.json': '{"name":"static"}',
		'index.ts': `export default async () => fetch('https://api.example.com', { headers: { authorization: 'Bearer {{secret:LOCKED}} {{secret:OPEN}} {{secret:ALLOWED}}' } })`,
	},
	'pkg-dynamic': {
		'package.json': '{"name":"dynamic"}',
		'index.ts':
			'export default async (name: string) => fetch(`https://api.example.com?k={{secret:${name}}}`)',
	},
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.listCandidatePackages.mockResolvedValue({
		packages: [savedPackage('pkg-static'), savedPackage('pkg-dynamic')],
		nextCursor: null,
	})
	mocks.accessKind.mockResolvedValue('self_authored')
	mocks.loadPackageSourceRowForUser.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			id: sourceId,
			published_commit: 'c1',
			source_root: '',
			manifest_path: 'package.json',
		}),
	)
	mocks.readPublishedSourceSnapshot.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			files: files[sourceId.replace('source-', '')],
		}),
	)
})

test('dry run joins static names and log markers without changing lists', async () => {
	const { sqlite, db } = setup()
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit: null,
		logSince: '2026-10-23',
	})
	expect(result).toMatchObject({
		dryRun: true,
		pairs: 2,
		staticOnlyPairs: 1,
		logOnlyPairs: 1,
		logOnlyUnresolvedPairs: 1,
		unresolvedPackages: 1,
		owners: 1,
		wouldGrant: 2,
		granted: 0,
	})
	expect(
		result.details.map((pair) => [
			pair.credentialId,
			pair.packageId,
			pair.source,
		]),
	).toEqual([
		['cred-locked', 'pkg-static', 'static'],
		['cred-dynamic', 'pkg-dynamic', 'log'],
	])
	const rows = sqlite
		.prepare('SELECT id, allowed_packages FROM secret_entries ORDER BY id')
		.all()
	expect(rows).toContainEqual({
		id: 'cred-locked',
		allowed_packages: '["pkg-other"]',
	})
	expect(mocks.auditBatch).not.toHaveBeenCalled()
})

test('unadopted forks are skipped and log pairs before the cutoff drop out', async () => {
	const { db } = setup()
	mocks.accessKind.mockImplementation(
		async ({ savedPackage }: { savedPackage: { id: string } }) =>
			savedPackage.id === 'pkg-static' ? null : 'adopted',
	)
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit: null,
		logSince: '2026-10-23',
		logLastSeenAfter: '2026-10-25T00:00:00.000Z',
	})
	expect(result).toMatchObject({ skippedUnadoptedFork: 1, pairs: 0 })
})

test('apply adds the package and audits the #4129 reason and source', async () => {
	const { sqlite, db } = setup()
	const audit = {} as never
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit,
		dryRun: false,
		logSince: '2026-10-23',
	})
	expect(result).toMatchObject({ granted: 2, wouldGrant: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT allowed_packages FROM secret_entries WHERE id = 'cred-locked'`,
			)
			.get(),
	).toEqual({ allowed_packages: '["pkg-other","pkg-static"]' })
	expect(mocks.auditBatch).toHaveBeenCalledWith(
		expect.objectContaining({
			audit,
			onlyIfChanged: true,
			event: expect.objectContaining({
				action: 'credential.allowed_packages_updated',
				resourceType: 'credential',
				resourceId: 'cred-locked',
				details: expect.objectContaining({
					packages: { added: ['pkg-static'], removed: [] },
					reason: 'grandfathered for #4129',
					source: 'static',
				}),
			}),
		}),
	)
	const again = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit,
		dryRun: false,
		logSince: '2026-10-23',
	})
	expect(again).toMatchObject({ granted: 0, pairs: 0, alreadyAllowed: 1 })
})

test('grant never widens an empty list and skips missing credentials', async () => {
	const { db } = setup()
	const base = {
		db,
		audit: null,
		ownerId: owner,
		packageId: 'pkg-x',
		source: 'static' as const,
	}
	await expect(
		grantGrandfatheredPackageAccess({ ...base, credentialId: 'cred-open' }),
	).resolves.toBe('already_allowed')
	await expect(
		grantGrandfatheredPackageAccess({ ...base, credentialId: 'nope' }),
	).resolves.toBe('missing')
})

test('log markers for unadopted forks never become log-only pairs', async () => {
	const { db } = setup()
	mocks.accessKind.mockImplementation(
		async ({ savedPackage }: { savedPackage: { id: string } }) =>
			savedPackage.id === 'pkg-dynamic' ? null : 'self_authored',
	)
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit: null,
		logSince: '2026-10-23',
	})
	expect(result).toMatchObject({
		skippedUnadoptedFork: 1,
		pairs: 1,
		staticOnlyPairs: 1,
		logOnlyPairs: 0,
	})
})

test('a full page of packages stays under the D1 bound-parameter limit', async () => {
	const { db } = setup()
	mocks.listCandidatePackages.mockResolvedValue({
		packages: [
			savedPackage('pkg-static'),
			savedPackage('pkg-dynamic'),
			...Array.from({ length: 198 }, (_, index) =>
				savedPackage(`pkg-empty-${index}`),
			),
		],
		nextCursor: null,
	})
	mocks.readPublishedSourceSnapshot.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			files: files[sourceId.replace('source-', '')] ?? {
				'package.json': '{"name":"empty"}',
				'index.ts': 'export default () => 1',
			},
		}),
	)
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit: null,
		limit: 200,
		logSince: '2026-10-23',
	})
	expect(result).toMatchObject({
		scannedPackages: 200,
		pairs: 2,
		logOnlyPairs: 1,
	})
})

test('an eligibility lookup failure keeps log markers from granting', async () => {
	const { db } = setup()
	mocks.accessKind.mockImplementation(
		async ({ savedPackage }: { savedPackage: { id: string } }) => {
			if (savedPackage.id === 'pkg-dynamic') throw new Error('lookup failed')
			return 'self_authored'
		},
	)
	const result = await runAllowedPackagesGrandfather({
		env: { APP_DB: db } as Env,
		audit: null,
		logSince: '2026-10-23',
	})
	expect(result).toMatchObject({
		skippedEligibilityUnknown: 1,
		unresolvedPackages: 1,
		pairs: 1,
		logOnlyPairs: 0,
	})
})

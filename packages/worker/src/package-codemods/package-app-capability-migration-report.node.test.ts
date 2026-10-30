import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	declarePackageAppCapabilitiesCodemodId,
	type DeclarePackageAppCapabilitiesOwnerDetail,
} from './codemods/0018-declare-package-app-capabilities.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunItemById,
	insertPackageCodemodRunItem,
} from './ledger.ts'
import { buildPackageAppCapabilityMigrationReport } from './package-app-capability-migration-report.ts'

const noUnresolved = {
	computedCalls: 0,
	mcpCalls: 0,
	unresolvedImports: 0,
	unknownCapabilityNames: 0,
	credentialNamedCalls: 0,
}

function detail(
	addedCapabilities: Array<string>,
	unresolved: Partial<typeof noUnresolved> = {},
): string {
	return JSON.stringify({
		addedCapabilities,
		sources: {
			direct: addedCapabilities.length,
			importClosure: 0,
			observed: 0,
		},
		unresolved: { ...noUnresolved, ...unresolved },
	} satisfies DeclarePackageAppCapabilitiesOwnerDetail)
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	await createPackageCodemodRun(db, {
		id: 'run-1',
		codemodId: declarePackageAppCapabilitiesCodemodId,
		mode: 'dry-run',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
	})
	const item = (
		id: string,
		userId: string,
		packageId: string,
		status: string,
		ownerDetailJson: string | null,
		createdAt?: string,
	) =>
		insertPackageCodemodRunItem(db, {
			id,
			runId: 'run-1',
			userId: ownerIdFromStored(userId),
			packageId,
			kodyId: `kody-${packageId}`,
			status,
			ownerDetailJson,
			createdAt,
		})
	await item(
		'item-1',
		'user-a',
		'pkg-example-app',
		'dry-run-ok',
		detail(['secretList', 'jobList']),
	)
	await item(
		'item-2',
		'user-a',
		'pkg-example-app-2',
		'dry-run-ok',
		detail(['secretList']),
	)
	await item(
		'item-3',
		'user-b',
		'pkg-example-app-3',
		'needs-manual',
		detail([], { computedCalls: 2 }),
	)
	await item('item-4', 'user-c', 'pkg-example-helper', 'no-match', null)
	return { db, item }
}

test('the migration report counts apps, owners, capabilities, and unresolved apps', async () => {
	const { db } = await setup()
	expect(
		await buildPackageAppCapabilityMigrationReport({ db, runId: 'run-1' }),
	).toEqual({
		runId: 'run-1',
		codemodId: declarePackageAppCapabilitiesCodemodId,
		mode: 'dry-run',
		status: expect.any(String),
		items: {
			total: 4,
			byStatus: { 'dry-run-ok': 2, 'needs-manual': 1, 'no-match': 1 },
		},
		appsAffected: 2,
		ownersAffected: 1,
		capabilitiesAdded: {
			total: 3,
			byCapability: { jobList: 1, secretList: 2 },
		},
		unresolvedApps: {
			count: 1,
			apps: [
				{ packageId: 'pkg-example-app-3', ...noUnresolved, computedCalls: 2 },
			],
		},
		app: null,
	})
})

test('the migration report returns one app list only when asked, and only for 0018 runs', async () => {
	const { db } = await setup()
	const report = await buildPackageAppCapabilityMigrationReport({
		db,
		runId: 'run-1',
		packageId: 'pkg-example-app',
	})
	expect(report?.app).toEqual({
		packageId: 'pkg-example-app',
		addedCapabilities: ['secretList', 'jobList'],
	})
	expect(
		(await getPackageCodemodRunItemById(db, 'item-1'))?.ownerDetailJson,
	).toBe(detail(['secretList', 'jobList']))
	await createPackageCodemodRun(db, {
		id: 'run-other',
		codemodId: '0017-detect-package-app-visitor-authority',
		mode: 'scan',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
	})
	expect(
		await buildPackageAppCapabilityMigrationReport({ db, runId: 'run-other' }),
	).toBeNull()
	await createPackageCodemodRun(db, {
		id: 'run-scan',
		codemodId: declarePackageAppCapabilitiesCodemodId,
		mode: 'scan',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
	})
	expect(
		await buildPackageAppCapabilityMigrationReport({ db, runId: 'run-scan' }),
	).toBeNull()
	expect(
		await buildPackageAppCapabilityMigrationReport({ db, runId: 'missing' }),
	).toBeNull()
})

test('the migration report counts each package once, using its latest row', async () => {
	const { db, item } = await setup()
	await item(
		'item-1-repeat',
		'user-a',
		'pkg-example-app',
		'dry-run-ok',
		detail(['secretList', 'jobList']),
		'2999-01-01T00:00:00.000Z',
	)
	await item(
		'item-3-repeat',
		'user-b',
		'pkg-example-app-3',
		'dry-run-ok',
		detail(['emailSend']),
		'2999-01-01T00:00:00.000Z',
	)
	const report = await buildPackageAppCapabilityMigrationReport({
		db,
		runId: 'run-1',
	})
	expect(report?.items).toEqual({
		total: 4,
		byStatus: { 'dry-run-ok': 3, 'no-match': 1 },
	})
	expect(report?.appsAffected).toBe(3)
	expect(report?.ownersAffected).toBe(2)
	expect(report?.capabilitiesAdded).toEqual({
		total: 4,
		byCapability: { emailSend: 1, jobList: 1, secretList: 2 },
	})
	expect(report?.unresolvedApps).toEqual({ count: 0, apps: [] })
})

test('an apply retry that comes back clean keeps the applied row', async () => {
	const { db, item } = await setup()
	await item(
		'item-1-applied',
		'user-a',
		'pkg-example-app',
		'applied',
		detail(['secretList', 'jobList']),
		'2998-01-01T00:00:00.000Z',
	)
	await item(
		'item-1-retry',
		'user-a',
		'pkg-example-app',
		'clean',
		null,
		'2999-01-01T00:00:00.000Z',
	)
	const report = await buildPackageAppCapabilityMigrationReport({
		db,
		runId: 'run-1',
	})
	expect(report?.items.byStatus.applied).toBe(1)
	expect(report?.items.byStatus.clean).toBeUndefined()
	expect(report?.capabilitiesAdded.byCapability.secretList).toBe(2)
})

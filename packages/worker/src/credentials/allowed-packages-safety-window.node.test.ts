import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { setFeatureFlagGlobalState } from '#worker/feature-flags/service.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({ auditBatch: vi.fn(), failBatch: false }))
vi.mock('#worker/orgs/org-audit.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#worker/orgs/org-audit.ts')>()),
	runAppDbBatchWithOrgAudit: async (input: {
		statements: Array<{ run(): Promise<{ meta?: { changes?: number } }> }>
		onlyIfChanged?: boolean
	}) => {
		if (mocks.failBatch) throw new Error('audit batch failed')
		let changes = 0
		for (const statement of input.statements) {
			changes = (await statement.run()).meta?.changes ?? 0
		}
		if (!input.onlyIfChanged || changes > 0) mocks.auditBatch(input)
		return { changed: changes > 0 }
	},
}))

const {
	isAllowedPackagesSafetyWindowActive,
	tryAllowedPackagesSafetyWindowGrant,
} = await import('./allowed-packages-safety-window.ts')

const owner = ownerIdFromStored('owner-1')
// Window: 2026-11-02 to 2026-12-02.
const cutoverAt = '2026-12-02T00:00:00.000Z'
const inWindow = new Date('2026-11-10T00:00:00.000Z')

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(
		`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('b1', '${owner}', 'user', '')`,
	)
	const insert = sqlite.prepare(
		`INSERT INTO secret_entries (bucket_id, id, name, encrypted_value, allowed_packages, created_at) VALUES ('b1', ?, ?, 'x', '["pkg-other"]', ?)`,
	)
	insert.run('cred-old', 'OLD', '2026-10-01 00:00:00')
	insert.run('cred-new', 'NEW', '2026-11-05 00:00:00')
	const db = createD1FromSqlite(sqlite)
	return { sqlite, db, env: { APP_DB: db, AUDIT_DB: db } as unknown as Env }
}

function grant(
	env: Env,
	overrides: Partial<
		Parameters<typeof tryAllowedPackagesSafetyWindowGrant>[0]
	> = {},
) {
	return tryAllowedPackagesSafetyWindowGrant({
		env,
		ownerId: owner,
		credentialId: 'cred-old',
		packageId: 'pkg-1',
		packageCreatedAt: '2026-09-01T00:00:00.000Z',
		accessKind: 'self_authored',
		now: inWindow,
		cutoverAt,
		...overrides,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.failBatch = false
})

async function setFlag(db: D1Database, enabled: boolean) {
	await setFeatureFlagGlobalState(db, {
		key: 'credential-allowed-packages-safety-window',
		enabled,
		rolloutPercent: null,
		updatedBy: 1,
	})
}

test('flag off: nothing is granted or allowed', async () => {
	const { env, db, sqlite } = setup()
	sqlite.exec('PRAGMA foreign_keys = OFF')
	await setFlag(db, false)
	await expect(grant(env)).resolves.toBe(false)
	expect(
		sqlite
			.prepare(
				`SELECT allowed_packages FROM secret_entries WHERE id = 'cred-old'`,
			)
			.get(),
	).toEqual({ allowed_packages: '["pkg-other"]' })
})

test('flag on in the window: pre-cutover pair is added, audited and logged, once', async () => {
	const { env, db, sqlite } = setup()
	sqlite.exec('PRAGMA foreign_keys = OFF')
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	await expect(grant(env)).resolves.toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT allowed_packages FROM secret_entries WHERE id = 'cred-old'`,
			)
			.get(),
	).toEqual({ allowed_packages: '["pkg-1","pkg-other"]' })
	expect(mocks.auditBatch).toHaveBeenCalledTimes(1)
	expect(mocks.auditBatch.mock.calls[0]?.[0].event).toMatchObject({
		action: 'credential.allowed_packages_updated',
		details: {
			packages: { added: ['pkg-1'], removed: [] },
			reason: 'grandfathered for #4129',
			source: 'safety_window',
		},
	})
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining('credential_allowed_packages_safety_window_grant'),
	)

	// A credential or package created after the window started is allowed
	// without a grant; after cutover the rule is strict.
	info.mockClear()
	await expect(grant(env, { credentialId: 'cred-new' })).resolves.toBe(true)
	await expect(
		grant(env, {
			packageId: 'pkg-2',
			packageCreatedAt: '2026-11-03T00:00:00.000Z',
		}),
	).resolves.toBe(true)
	expect(info).toHaveBeenCalledTimes(2)
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining('credential_allowed_packages_safety_window_allow'),
	)
	info.mockRestore()
	expect(
		sqlite
			.prepare(
				`SELECT allowed_packages FROM secret_entries WHERE id = 'cred-new'`,
			)
			.get(),
	).toEqual({ allowed_packages: '["pkg-other"]' })
	await expect(
		grant(env, { packageId: 'pkg-3', now: new Date(cutoverAt) }),
	).resolves.toBe(false)
	await expect(
		isAllowedPackagesSafetyWindowActive({ db, now: inWindow, cutoverAt }),
	).resolves.toBe(true)
	expect(mocks.auditBatch).toHaveBeenCalledTimes(1)
})

test('flag on in the window: a failed grant still allows access', async () => {
	const { env, sqlite } = setup()
	sqlite.exec('PRAGMA foreign_keys = OFF')
	mocks.failBatch = true
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const info = vi.spyOn(console, 'info').mockImplementation(() => {})
	await expect(grant(env)).resolves.toBe(true)
	expect(warn).toHaveBeenCalledWith(
		expect.stringContaining(
			'credential_allowed_packages_safety_window_grant_failed',
		),
	)
	expect(info).toHaveBeenCalledWith(
		expect.stringContaining('credential_allowed_packages_safety_window_allow'),
	)
	warn.mockRestore()
	info.mockRestore()
})

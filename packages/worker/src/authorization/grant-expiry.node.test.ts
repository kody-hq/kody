import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext as AuthRequestContext } from '@kody-internal/shared/request-context.ts'
import { afterEach, expect, test, vi } from 'vitest'
import {
	compileAccessForActor,
	type CompiledAccess,
} from '#worker/authorization/access-compile.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import {
	createOrg,
	listGrants,
	upsertGrant,
	type GrantSubject,
} from '#worker/orgs/access-writes.ts'
import {
	memoizePerRequest,
	runWithRequestContext,
} from '#worker/request-context.ts'
import { withAccessEpochWriteGuard } from '#worker/test-support/access-epoch-write-guard.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const expiryMigration = '0214-grants-expiry-and-profile-subject.sql'
const start = new Date('2026-11-01T12:00:00.000Z')
const later = '2026-11-01T13:00:00.000Z'

afterEach(() => {
	vi.useRealTimers()
})

async function seed() {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(start)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const db = withAccessEpochWriteGuard(createD1FromSqlite(sqlite))
	const creatorId = testStableUserIdFromEmail('creator@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'expiry-co',
		displayName: 'Expiry Co',
		createdByUserId: creatorId,
		audit: createTestOrgAuditWriter(),
	})
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(org.id, memberId, start.toISOString())
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team_core', ?, 'core', 'Core', ?, ?)`,
		)
		.run(org.id, start.toISOString(), start.toISOString())
	sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team_core', ?, ?)`,
		)
		.run(memberId, start.toISOString())
	const grant = (
		subject: GrantSubject,
		resourceId: string,
		expiresAt?: string | null,
	) =>
		upsertGrant({
			db,
			orgId: org.id,
			resourceType: 'package',
			resourceId,
			family: 'package',
			subject,
			preset: 'use',
			permissions: null,
			createdByUserId: creatorId,
			...(expiresAt === undefined ? {} : { expiresAt }),
			audit: createTestOrgAuditWriter(),
		})
	const compile = () =>
		compileAccessForActor({
			db,
			orgId: ownerIdFromStored(String(org.id)),
			userId: memberId,
			role: 'member',
		})
	return { sqlite, db, org, memberId, grant, compile }
}

function readable(compiled: CompiledAccess, packageId: string) {
	return (
		compiled.resourcePermissions
			.get(`package:${packageId}`)
			?.has('package:read') ?? false
	)
}

test('user, team, and org subject grants stop counting at expires_at', async () => {
	const { org, grant, compile } = await seed()
	await grant(
		{ type: 'user', id: testStableUserIdFromEmail('member@example.com') },
		'p-user',
		later,
	)
	await grant({ type: 'team', id: 'team_core' }, 'p-team', later)
	await grant({ type: 'org', id: org.id }, 'p-org', later)
	await grant({ type: 'team', id: 'team_core' }, 'p-forever')

	const before = await compile()
	for (const id of ['p-user', 'p-team', 'p-org', 'p-forever']) {
		expect(readable(before, id)).toBe(true)
	}
	expect(before.validUntil).toBe(later)

	vi.setSystemTime(new Date(Date.parse(later) - 1))
	expect(readable(await compile(), 'p-user')).toBe(true)

	// Same access_epoch: only valid_until makes the cached compile a miss.
	vi.setSystemTime(new Date(later))
	const after = await compile()
	expect(after.epoch).toBe(before.epoch)
	for (const id of ['p-user', 'p-team', 'p-org']) {
		expect(readable(after, id)).toBe(false)
	}
	expect(readable(after, 'p-forever')).toBe(true)
	expect(after.validUntil).toBeNull()
})

test('a long run stops honoring a grant that expires mid-run', async () => {
	const { memberId, grant, compile } = await seed()
	await grant({ type: 'user', id: memberId }, 'p-run', later)
	await runWithRequestContext(
		new Request('https://kody.test/run'),
		async () => {
			expect(readable(await compile(), 'p-run')).toBe(true)
			vi.setSystemTime(new Date(later))
			expect(readable(await compile(), 'p-run')).toBe(false)
		},
	)
})

test('a request context recompiles its permissions once a grant expires', async () => {
	const { db, org, memberId, grant } = await seed()
	await grant({ type: 'user', id: memberId }, 'p-ctx', later)
	const env = { APP_DB: db } as unknown as Env
	const request = {
		actor: { userId: memberId, username: 'member' },
		org: { id: ownerIdFromStored(String(org.id)), slug: 'acme' },
		membership: { role: 'member' },
		credential: { profileId: null },
	} as unknown as AuthRequestContext
	const canRead = async () =>
		(await computeEffectivePermissions({ env, request })).resourcePermissions
			.get('package:p-ctx')
			?.has('package:read') ?? false
	expect(await canRead()).toBe(true)
	vi.setSystemTime(new Date(later))
	expect(await canRead()).toBe(false)
})

test('a per-request load that is already stale when it settles reloads', async () => {
	let loads = 0
	const load = async () => ++loads
	const isFresh = (value: number) => value > 1
	expect(await memoizePerRequest({ key: 'k', load, isFresh })).toBe(2)
	loads = 0
	await runWithRequestContext(new Request('https://kody.test/x'), async () => {
		expect(await memoizePerRequest({ key: 'k', load, isFresh })).toBe(2)
		expect(await memoizePerRequest({ key: 'k', load, isFresh })).toBe(2)
	})
	expect(loads).toBe(2)
})

test('profile subject rows never reach a person and are not listed', async () => {
	const { sqlite, db, org, memberId, compile } = await seed()
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES ('g-profile', ?, 'package', 'p-profile', 'profile', ?, 'use', ?, ?, ?)`,
		)
		.run(org.id, memberId, memberId, start.toISOString(), start.toISOString())
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-profile', 'package:read')`,
		)
		.run()
	expect(readable(await compile(), 'p-profile')).toBe(false)
	expect(await listGrants({ db, orgId: org.id })).toEqual([])
})

test('rewriting a grant keeps a live expiry, clears on null, and restarts an expired one', async () => {
	const { db, org, memberId, grant } = await seed()
	const subject = { type: 'user', id: memberId } as const
	await grant(subject, 'p-edit', later)
	expect((await grant(subject, 'p-edit')).expiresAt).toBe(later)
	expect((await grant(subject, 'p-edit', null)).expiresAt).toBeNull()

	await grant(subject, 'p-edit', later)
	vi.setSystemTime(new Date(later))
	expect((await grant(subject, 'p-edit')).expiresAt).toBeNull()
	const [listed] = await listGrants({ db, orgId: org.id })
	expect(listed?.expiresAt).toBeNull()
})

test('the 0214 rebuild keeps every grant and admits expiry and profile subjects', () => {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	const names = readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql'))
		.sort()
	const run = (include: (name: string) => boolean) => {
		for (const name of names.filter(include)) {
			sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
		}
	}
	run((name) => name < expiryMigration)
	const insert = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at, origin
		) VALUES (?, 'org_acme', 'package', ?, ?, ?, 'use', 'u1', '2026-10-01', '2026-10-02', ?, ?)`,
	)
	insert.run('g-user', 'p1', 'user', 'u2', null, 'created')
	insert.run('g-team', 'p1', 'team', 't1', null, 'manual')
	insert.run('g-deleted', 'p2', 'user', 'u2', '2026-10-03', 'manual')
	insert.run('g-org', 'p3', 'org', 'org_acme', null, 'manual')
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission) VALUES ('g-team', 'package:read')`,
		)
		.run()
	expect(() =>
		insert.run('g-early', 'p4', 'profile', 'prof1', null, 'manual'),
	).toThrow(/CHECK constraint failed/)
	const before = sqlite.prepare(`SELECT * FROM grants ORDER BY id`).all()

	run((name) => name === expiryMigration)

	const after = sqlite
		.prepare(`SELECT * FROM grants ORDER BY id`)
		.all() as Array<Record<string, unknown>>
	expect(after.map(({ expires_at, ...rest }) => rest)).toEqual(before)
	expect(after.every((row) => row['expires_at'] === null)).toBe(true)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS n FROM grant_permissions`).get(),
	).toEqual({ n: 1 })
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'grants' AND sql IS NOT NULL ORDER BY name`,
			)
			.all(),
	).toEqual([{ name: 'grants_live_subject' }, { name: 'grants_subject' }])
	insert.run('g-profile', 'p4', 'profile', 'prof1', null, 'manual')
	expect(() =>
		insert.run('g-bad-org', 'p5', 'org', 'org_other', null, 'manual'),
	).toThrow(/CHECK constraint failed/)
	expect(() =>
		insert.run('g-bad-origin', 'p6', 'user', 'u3', null, 'copied'),
	).toThrow(/CHECK constraint failed/)
	expect(
		(
			sqlite.prepare(`PRAGMA table_info(access_cache)`).all() as Array<{
				name: string
			}>
		).map((column) => column.name),
	).toContain('valid_until')
})

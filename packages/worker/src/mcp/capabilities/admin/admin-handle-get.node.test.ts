import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { loadAdminHandleHolders } from '#worker/admin/handle-get.ts'
import { compactReservedUsername } from '#worker/identity/reserved-usernames.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminHandleGetCapability } from './admin-handle-get.ts'

const patEmail = 'pat@example.com'
const goneEmail = 'tombstone-secret@example.com'
const mixedEmail = 'mixed@example.com'
const patId = testStableUserIdFromEmail(patEmail)
const goneId = testStableUserIdFromEmail(goneEmail)
const mixedId = testStableUserIdFromEmail(mixedEmail)

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createContext(roles: Array<string>, db: D1Database) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
	}
}

function seedIdentity(sqlite: DatabaseSync) {
	const insertUser = sqlite.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, created_at, updated_at, deleted_at
		) VALUES (?, ?, 'hash', ?, ?, ?, ?)`,
	)
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, created_at, updated_at, deleted_at, suspended_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
	const insertHandle = sqlite.prepare(
		`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES (?, ?, ?, ?)`,
	)
	insertUser.run(
		'pat',
		patEmail,
		patId,
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z',
		null,
	)
	insertOrg.run(
		patId,
		'pat',
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z',
		null,
		null,
	)
	insertHandle.run('pat', patId, patId, '2026-01-01T00:00:00.000Z')

	insertUser.run(
		'gone-user',
		goneEmail,
		goneId,
		'2026-02-01T00:00:00.000Z',
		'2026-02-01T00:00:00.000Z',
		'2026-03-01T00:00:00.000Z',
	)
	insertHandle.run('gone-user', goneId, null, '2026-02-01T00:00:00.000Z')

	insertUser.run(
		'MiXeD',
		mixedEmail,
		mixedId,
		'2026-02-02T00:00:00.000Z',
		'2026-02-02T00:00:00.000Z',
		null,
	)

	insertOrg.run(
		'org-acme',
		'acme-org',
		'2026-02-03T00:00:00.000Z',
		'2026-02-03T00:00:00.000Z',
		'2026-03-02T00:00:00.000Z',
		null,
	)
	insertHandle.run('acme-org', null, 'org-acme', '2026-02-03T00:00:00.000Z')

	insertOrg.run(
		'org-foo',
		'foo_bar',
		'2026-02-04T00:00:00.000Z',
		'2026-02-04T00:00:00.000Z',
		null,
		null,
	)

	insertOrg.run(
		'org-paused',
		'paused',
		'2026-02-05T00:00:00.000Z',
		'2026-02-05T00:00:00.000Z',
		null,
		'2026-02-06T00:00:00.000Z',
	)
	insertHandle.run('paused', null, 'org-paused', '2026-02-05T00:00:00.000Z')

	insertHandle.run('oldname', null, null, '2026-02-07T00:00:00.000Z')

	insertUser.run(
		'other-user',
		'other@example.com',
		testStableUserIdFromEmail('other@example.com'),
		'2026-02-08T00:00:00.000Z',
		'2026-02-08T00:00:00.000Z',
		null,
	)
}

test('adminHandleGet rejects non-admins', async () => {
	const { db } = createMigratedDb()
	await expect(
		adminHandleGetCapability.handler(
			{ handle: 'pat' },
			createContext(['user'], db),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
			path: 'adminHandleGet',
		}),
	)
})

test('adminHandleGet resolves user, org, soft-deleted, case, and separator-stripped handles', async () => {
	expect(compactReservedUsername('Foo_Bar-Baz')).toBe('foobarbaz')
	const { sqlite, db } = createMigratedDb()
	seedIdentity(sqlite)
	const ctx = createContext(['admin'], db)

	const person = await adminHandleGetCapability.handler({ handle: 'PAT' }, ctx)
	expect(person).toEqual({
		compact: 'pat',
		total: 3,
		truncated: false,
		holders: [
			{
				source: 'handle',
				ownerKind: 'org',
				id: patId,
				storedHandle: 'pat',
				createdAt: '2026-01-01T00:00:00.000Z',
				deletedAt: null,
			},
			{
				source: 'org',
				ownerKind: 'org',
				id: patId,
				storedHandle: 'pat',
				createdAt: '2026-01-01T00:00:00.000Z',
				deletedAt: null,
			},
			{
				source: 'user',
				ownerKind: 'user',
				id: patId,
				storedHandle: 'pat',
				createdAt: '2026-01-01T00:00:00.000Z',
				deletedAt: null,
			},
		],
	})
	expect(JSON.stringify(person)).not.toContain(patEmail)

	const tombstone = await adminHandleGetCapability.handler(
		{ handle: 'Gone_User' },
		ctx,
	)
	expect(tombstone.compact).toBe('goneuser')
	expect(tombstone.holders).toEqual([
		{
			source: 'handle',
			ownerKind: 'user',
			id: goneId,
			storedHandle: 'gone-user',
			createdAt: '2026-02-01T00:00:00.000Z',
			deletedAt: '2026-03-01T00:00:00.000Z',
		},
		{
			source: 'user',
			ownerKind: 'user',
			id: goneId,
			storedHandle: 'gone-user',
			createdAt: '2026-02-01T00:00:00.000Z',
			deletedAt: '2026-03-01T00:00:00.000Z',
		},
	])
	expect(JSON.stringify(tombstone)).not.toContain(goneEmail)

	const deletedOrg = await adminHandleGetCapability.handler(
		{ handle: 'ACMEORG' },
		ctx,
	)
	expect(deletedOrg.holders).toEqual([
		{
			source: 'handle',
			ownerKind: 'org',
			id: 'org-acme',
			storedHandle: 'acme-org',
			createdAt: '2026-02-03T00:00:00.000Z',
			deletedAt: '2026-03-02T00:00:00.000Z',
		},
		{
			source: 'org',
			ownerKind: 'org',
			id: 'org-acme',
			storedHandle: 'acme-org',
			createdAt: '2026-02-03T00:00:00.000Z',
			deletedAt: '2026-03-02T00:00:00.000Z',
		},
	])

	const mixedCase = await adminHandleGetCapability.handler(
		{ handle: 'mixed' },
		ctx,
	)
	expect(mixedCase.holders).toEqual([
		{
			source: 'user',
			ownerKind: 'user',
			id: mixedId,
			storedHandle: 'MiXeD',
			createdAt: '2026-02-02T00:00:00.000Z',
			deletedAt: null,
		},
	])

	const separators = await adminHandleGetCapability.handler(
		{ handle: 'foo-bar' },
		ctx,
	)
	expect(separators).toMatchObject({
		compact: 'foobar',
		holders: [
			{
				source: 'org',
				ownerKind: 'org',
				id: 'org-foo',
				storedHandle: 'foo_bar',
				deletedAt: null,
			},
		],
	})

	const unowned = await loadAdminHandleHolders(db, 'oldname')
	expect(unowned.holders).toEqual([
		{
			source: 'handle',
			ownerKind: null,
			id: null,
			storedHandle: 'oldname',
			createdAt: '2026-02-07T00:00:00.000Z',
			deletedAt: null,
		},
	])

	const missing = await adminHandleGetCapability.handler(
		{ handle: 'zzznone' },
		ctx,
	)
	expect(missing).toEqual({
		compact: 'zzznone',
		holders: [],
		total: 0,
		truncated: false,
	})

	await expect(
		adminHandleGetCapability.handler({ handle: '---' }, ctx),
	).rejects.toThrow('Handle is empty after reserved-name compaction.')

	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'pat' }),
	).resolves.toMatchObject({ handle: 'pat', ownerId: patId })
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'acme-org' }),
	).resolves.toBeNull()
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'paused' }),
	).resolves.toBeNull()
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'foo_bar' }),
	).resolves.toBeNull()
	await expect(
		findPublicOwnerIdentityByHandle({ db, handle: 'gone-user' }),
	).resolves.toBeNull()

	const suspended = await adminHandleGetCapability.handler(
		{ handle: 'paused' },
		ctx,
	)
	expect(suspended.holders.map((holder) => holder.source).sort()).toEqual([
		'handle',
		'org',
	])
	expect(suspended.holders.every((holder) => holder.deletedAt == null)).toBe(
		true,
	)

	const compact = 'abcdefghij'
	const spellings: Array<string> = []
	const gaps = compact.length - 1
	for (let mask = 0; spellings.length < 51; mask += 1) {
		let spelling = ''
		for (let index = 0; index < compact.length; index += 1) {
			spelling += compact[index] ?? ''
			if (index < gaps && (mask & (1 << index)) !== 0) spelling += '-'
		}
		spellings.push(spelling)
	}
	const insertOverflow = sqlite.prepare(
		`INSERT INTO handles (handle, user_id, org_id, created_at) VALUES (?, NULL, NULL, ?)`,
	)
	for (const spelling of spellings) {
		insertOverflow.run(spelling, '2026-04-01T00:00:00.000Z')
	}
	const overflow = await adminHandleGetCapability.handler(
		{ handle: 'abc-defghij' },
		ctx,
	)
	expect(overflow.compact).toBe(compact)
	expect(overflow.holders).toHaveLength(50)
	expect(overflow.total).toBe(51)
	expect(overflow.truncated).toBe(true)
	expect(overflow.holders.every((holder) => holder.source === 'handle')).toBe(
		true,
	)

	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminHandleGet',
			result: 'success',
			reason: 'compact=pat;returned=3;total=3;truncated=false',
		}),
	)
	const reasons = logAuditEventSpy.mock.calls.map(
		([event]) => event.reason as string,
	)
	expect(reasons.some((reason) => reason.includes(goneEmail))).toBe(false)
	expect(reasons.some((reason) => reason.includes(patEmail))).toBe(false)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminHandleGet',
			result: 'success',
			reason: 'compact=abcdefghij;returned=50;total=51;truncated=true',
		}),
	)
})

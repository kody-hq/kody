import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import type { CompiledAccess } from '#worker/authorization/access-compile.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	addsEntries,
	boxExcess,
	excessFingerprint,
	narrowByProfile,
	type BoxPrincipal,
} from './box-access.ts'
import { refreshContextNotices } from './box-notices.ts'
import {
	dismissElevation,
	listContextNotices,
	recordElevation,
	takeUndeliveredNotices,
} from './notices.ts'
import { getExecutionContext } from './store.ts'

const orgId = 'org_acme'
const now = '2026-11-03T00:00:00.000Z'

function compiled(input: {
	org?: Array<string>
	resources?: Record<string, Array<string>>
	owner?: boolean
}): CompiledAccess {
	return {
		orgId: orgId as never,
		epoch: 0,
		isOwner: input.owner ?? false,
		orgPermissions: new Set(input.org ?? []) as never,
		resourcePermissions: new Map(
			Object.entries(input.resources ?? {}).map(([key, value]) => [
				key,
				new Set(value),
			]),
		) as never,
		validUntil: null,
	}
}

const person: BoxPrincipal = {
	kind: 'person',
	userId: 'user_op',
	profileId: null,
}

test('excess is the box login minus the grantee, per permission and resource', () => {
	const box = [
		{ permission: 'org:read' as const, resource: null },
		{ permission: 'package:execute' as const, resource: 'package:pkg_a' },
		{ permission: 'package:execute' as const, resource: 'package:pkg_b' },
	]
	const grantee = compiled({
		org: ['org:read'],
		resources: { 'package:pkg_a': ['package:execute'] },
	})
	expect(boxExcess(box, grantee)).toEqual([
		{ permission: 'package:execute', resource: 'package:pkg_b' },
	])
	expect(boxExcess(box, compiled({ owner: true }))).toEqual([])
	expect(boxExcess([{ permission: 'owner', resource: null }], grantee)).toEqual(
		[{ permission: 'owner', resource: null }],
	)
})

test('a profile login is the person narrowed by every profile layer', () => {
	const base = compiled({
		org: ['org:read', 'package:execute'],
		resources: { 'package:pkg_a': ['package:write'] },
	})
	const entries = narrowByProfile(base, [
		{
			orgPermissions: new Set(['org:read', 'secret:use']),
			resourcePermissions: new Map([
				['package:pkg_a', new Set(['package:write'])],
			]),
		},
		{
			orgPermissions: new Set(['org:read']),
			resourcePermissions: new Map([
				['package:pkg_a', new Set(['package:write'])],
			]),
		},
	])
	expect(entries).toEqual([
		{ permission: 'org:read', resource: null },
		{ permission: 'package:write', resource: 'package:pkg_a' },
	])
})

test('fingerprints change with the login, and only additions re-raise', async () => {
	const entries = [{ permission: 'org:read' as const, resource: null }]
	const profile: BoxPrincipal = {
		kind: 'profile',
		userId: 'user_op',
		profileId: 'prof_1',
	}
	expect(await excessFingerprint(person, entries)).not.toBe(
		await excessFingerprint(profile, entries),
	)
	expect(addsEntries(entries, [])).toBe(false)
	expect(addsEntries([], [{ permission: 'secret:use', resource: null }])).toBe(
		true,
	)
})

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
			public_key_jwk, thumbprint, created_at, grant_json, grant_version, login_kind, login_user_id)
		VALUES ('ec_mac', '${orgId}', 'user_op', 0, 'mac', '{}', 'thumb', '${now}', '{}', 1, 'person', 'user_op');
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
		VALUES ('${orgId}', 'acme', 0, '${now}', '${now}');
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
		VALUES ('${orgId}', 'user_op', 'owner', '${now}'),
		       ('${orgId}', 'user_friend', 'member', '${now}');
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('notices raise on new or added excess, dismiss by subject fingerprint, and deliver once per surface', async () => {
	const { db } = setup()
	const key = {
		contextId: 'ec_mac',
		orgId,
		userId: 'user_friend',
		principal: person,
	}
	const one = [{ permission: 'org:read' as const, resource: null }]
	const two = [...one, { permission: 'secret:use' as const, resource: null }]
	expect(await recordElevation(db, { ...key, entries: two })).toBe(true)
	const [first] = await listContextNotices(db, { contextId: 'ec_mac', orgId })
	expect(await dismissElevation(db, { ...key, fingerprint: 'stale' })).toBe(
		'changed',
	)
	expect(
		await dismissElevation(db, { ...key, fingerprint: first!.fingerprint }),
	).toBe('dismissed')
	// Losing an entry changes the fingerprint but never re-raises.
	expect(await recordElevation(db, { ...key, entries: one })).toBe(false)
	expect(
		await takeUndeliveredNotices(db, {
			userId: 'user_friend',
			orgId,
			surface: 'execute',
		}),
	).toEqual([])
	// A new entry re-raises and clears the dismissal.
	expect(await recordElevation(db, { ...key, entries: two })).toBe(true)
	const delivered = await takeUndeliveredNotices(db, {
		userId: 'user_friend',
		orgId,
		surface: 'execute',
	})
	expect(delivered).toHaveLength(1)
	expect(
		await takeUndeliveredNotices(db, {
			userId: 'user_friend',
			orgId,
			surface: 'execute',
		}),
	).toEqual([])
	expect(
		await takeUndeliveredNotices(db, {
			userId: 'user_friend',
			orgId,
			surface: 'search',
		}),
	).toHaveLength(1)
	// No excess clears the notice.
	await recordElevation(db, { ...key, entries: [] })
	expect(await listContextNotices(db, { contextId: 'ec_mac', orgId })).toEqual(
		[],
	)
})

test('refresh records an Owner box login as excess and flags team misconfiguration', async () => {
	const { sqlite, db } = setup()
	sqlite.exec(`
		INSERT INTO teams (id, org_id, slug, name, created_at, updated_at, deleted_at)
		VALUES ('team_x', '${orgId}', 'x', 'X', '${now}', '${now}', NULL);
		UPDATE execution_contexts SET team_id = 'team_x' WHERE id = 'ec_mac';
	`)
	const row = (await getExecutionContext(db, 'ec_mac'))!
	await refreshContextNotices(db, row, orgId, { userIds: ['user_friend'] })
	const notices = await listContextNotices(db, { contextId: 'ec_mac', orgId })
	const elevation = notices.find((notice) => notice.kind === 'elevation')
	expect(elevation?.subjectUserId).toBe('user_friend')
	expect(elevation?.detail).toMatchObject({
		entries: [{ permission: 'owner', resource: null }],
	})
	expect(
		notices.find((notice) => notice.kind === 'misconfigured')?.detail,
	).toEqual({ codes: ['personal_login_on_team_context'] })
})

test('refresh flags operator_left and a revoked box login token', async () => {
	const { sqlite, db } = setup()
	sqlite.exec(`
		UPDATE org_memberships SET deleted_at = '${now}' WHERE user_id = 'user_op';
		UPDATE execution_contexts SET login_token_id = 'tok_gone' WHERE id = 'ec_mac';
	`)
	const row = (await getExecutionContext(db, 'ec_mac'))!
	await refreshContextNotices(db, row, orgId, { userIds: [] })
	const notices = await listContextNotices(db, { contextId: 'ec_mac', orgId })
	expect(
		notices.find((notice) => notice.kind === 'misconfigured')?.detail,
	).toEqual({
		codes: ['login_stale', 'operator_left'],
	})
})

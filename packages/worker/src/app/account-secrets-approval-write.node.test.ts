/**
 * `/connect/secrets` host and package approvals widen where an org
 * credential's value can go, so they need Write on every credential they
 * change. A member with only Use is refused, a bulk approval is refused whole,
 * and the personal-org owner keeps approving their own credentials. The
 * `/connect/secret-set` save and the delete/disconnect actions run the same
 * shared checks as `secretSet`, `secretDelete`, and `secretDisconnect`.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import {
	approveAccountSecretAccess,
	deleteAccountSecret,
	disconnectAccountSecret,
	saveAccountSecret,
} from '#app/handlers/account-secrets.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { secretSetCapability } from '#mcp/capabilities/secrets/secret-set.ts'

const now = '2026-10-30T00:00:00.000Z'
const packageId = 'pkg-approval'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')!
	const memberId = testStableUserIdFromEmail('member@example.com')!
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
	].entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: stableUserId!,
			username: username!,
			createdAt: now,
		})
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, created_at, updated_at
			) VALUES (?, ?, 'approvals', 'approvals', 'Approvals', 'src-approvals', ?, ?)`,
		)
		.bind(packageId, ownerId, now, now)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const callerContext = (
		userId: string,
		username: string,
		role: OrgRole | null,
	) =>
		createMcpCallerContext({
			source: { kind: 'session' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(ownerId), slug: 'owneruser' },
				role,
			},
		})
	const owner = callerContext(ownerId, 'owneruser', 'owner')
	// A fresh session per call: permissions are memoized per request context.
	const member = () => callerContext(memberId, 'memberuser', 'member')
	const set = async (name: string) => {
		await secretSetCapability.handler(
			{ name, scope: 'user', value: `${name}-value` } as never,
			{ env, callerContext: owner },
		)
		const row = await db
			.prepare(
				`SELECT e.id FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{ id: string }>()
		return row!.id
	}
	const grantMember = async (
		credentialId: string,
		permissions: Array<OrgPermission>,
	) =>
		await upsertGrant({
			db,
			orgId: ownerId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: memberId },
			preset: null,
			permissions,
			createdByUserId: ownerId,
			audit: createTestOrgAuditWriter(),
		})
	const entry = async (name: string) =>
		await db
			.prepare(
				`SELECT e.allowed_hosts, e.allowed_packages FROM secret_entries e
				 JOIN secret_buckets b ON b.id = e.bucket_id
				 WHERE b.user_id = ? AND b.scope = 'user' AND e.name = ? AND e.deleted_at IS NULL`,
			)
			.bind(ownerId, name)
			.first<{ allowed_hosts: string; allowed_packages: string }>()
	const approve = (
		as: typeof owner,
		approval: {
			selectedSecretId?: string
			names?: Array<string>
			hosts?: Array<string>
			packageId?: string
		},
	) =>
		approveAccountSecretAccess({
			request: new Request('https://heykody.dev/connect/secrets'),
			env,
			user: { request: as.request, mcpUser: as.user } as never,
			refresh: {
				selectedSecretId: approval.selectedSecretId ?? null,
				approval: {
					hosts: approval.hosts ?? [],
					names: approval.names ?? [],
					scope: 'user',
					...(approval.packageId ? { packageId: approval.packageId } : {}),
				},
			},
		})
	const website = (as: typeof owner) => ({
		request: new Request('https://heykody.dev/connect/secret-set'),
		env,
		user: { request: as.request, mcpUser: as.user } as never,
	})
	return { owner, member, set, grantMember, entry, approve, website }
}

const hostsOf = (row: { allowed_hosts: string } | null) =>
	JSON.parse(row!.allowed_hosts) as Array<string>
const packagesOf = (row: { allowed_packages: string } | null) =>
	JSON.parse(row!.allowed_packages) as Array<string>

test('a member with only Use cannot add a host to an org credential', async () => {
	const t = await setup()
	const id = await t.set('orgApiKey')
	await t.grantMember(id, ['secret:use'])
	const result = await t.approve(t.member(), {
		selectedSecretId: 'user::::orgApiKey',
		hosts: ['api.example.com'],
	})
	expect(result.status).toBe(403)
	expect(result.data).toMatchObject({
		ok: false,
		error: expect.stringContaining(
			'You need Write on the credential "orgApiKey"',
		),
	})
	expect(hostsOf(await t.entry('orgApiKey'))).toEqual([])
})

test('a member with Write can add a host to an org credential', async () => {
	const t = await setup()
	const id = await t.set('orgApiKey')
	await t.grantMember(id, ['secret:use', 'secret:write'])
	const result = await t.approve(t.member(), {
		selectedSecretId: 'user::::orgApiKey',
		hosts: ['api.example.com'],
	})
	expect(result.data).toMatchObject({ ok: true, approvalKind: 'host' })
	expect(hostsOf(await t.entry('orgApiKey'))).toEqual(['api.example.com'])
})

test('a bulk host approval is refused whole when any credential lacks Write', async () => {
	const t = await setup()
	const writable = await t.set('writableKey')
	const useOnly = await t.set('useOnlyKey')
	await t.grantMember(writable, ['secret:use', 'secret:write'])
	await t.grantMember(useOnly, ['secret:use'])
	const result = await t.approve(t.member(), {
		names: ['writableKey', 'useOnlyKey'],
		hosts: ['api.example.com'],
	})
	expect(result.status).toBe(403)
	expect(result.data).toMatchObject({
		ok: false,
		error: expect.stringContaining(`you don't have it on "useOnlyKey"`),
	})
	expect(hostsOf(await t.entry('writableKey'))).toEqual([])
	expect(hostsOf(await t.entry('useOnlyKey'))).toEqual([])

	await t.grantMember(useOnly, ['secret:use', 'secret:write'])
	const allowed = await t.approve(t.member(), {
		names: ['writableKey', 'useOnlyKey'],
		hosts: ['api.example.com'],
	})
	expect(allowed.data).toMatchObject({ ok: true, approvalKind: 'host_bulk' })
	expect(hostsOf(await t.entry('writableKey'))).toEqual(['api.example.com'])
	expect(hostsOf(await t.entry('useOnlyKey'))).toEqual(['api.example.com'])
})

test('a member with only Use cannot grant a package an org credential', async () => {
	const t = await setup()
	const id = await t.set('orgApiKey')
	await t.grantMember(id, ['secret:use'])
	const single = await t.approve(t.member(), {
		selectedSecretId: 'user::::orgApiKey',
		packageId,
	})
	expect(single.status).toBe(403)
	const bulk = await t.approve(t.member(), {
		names: ['orgApiKey'],
		packageId,
	})
	expect(bulk.status).toBe(403)
	expect(packagesOf(await t.entry('orgApiKey'))).toEqual([])

	await t.grantMember(id, ['secret:use', 'secret:write'])
	const allowed = await t.approve(t.member(), {
		selectedSecretId: 'user::::orgApiKey',
		packageId,
	})
	expect(allowed.data).toMatchObject({ ok: true, approvalKind: 'package' })
	expect(packagesOf(await t.entry('orgApiKey'))).toEqual([packageId])
})

test('the owner still approves hosts and packages on their own credentials', async () => {
	const t = await setup()
	await t.set('ownKey')
	await t.set('otherKey')
	expect(
		(
			await t.approve(t.owner, {
				selectedSecretId: 'user::::ownKey',
				hosts: ['api.example.com'],
			})
		).data,
	).toMatchObject({ ok: true, approvalKind: 'host' })
	expect(
		(
			await t.approve(t.owner, {
				names: ['ownKey', 'otherKey'],
				hosts: ['api.other.example.com'],
			})
		).data,
	).toMatchObject({ ok: true, approvalKind: 'host_bulk' })
	expect(
		(await t.approve(t.owner, { names: ['ownKey', 'otherKey'], packageId }))
			.data,
	).toMatchObject({ ok: true, approvalKind: 'package_bulk' })
	expect(hostsOf(await t.entry('ownKey'))).toEqual([
		'api.example.com',
		'api.other.example.com',
	])
	expect(packagesOf(await t.entry('otherKey'))).toEqual([packageId])
})

test('a member with only Use cannot overwrite, delete, or disconnect an org credential', async () => {
	const t = await setup()
	const id = await t.set('orgApiKey')
	await t.grantMember(id, ['secret:use'])
	const saved = await saveAccountSecret({
		...t.website(t.member()),
		fields: {
			currentId: 'user::::orgApiKey',
			name: 'orgApiKey',
			scope: 'user',
			value: 'replaced',
			allowedHosts: ['api.example.com'],
		},
	})
	expect(saved.status).toBe(403)
	expect(saved.data).toMatchObject({
		error: expect.stringContaining('You need Write on this credential'),
	})
	expect(hostsOf(await t.entry('orgApiKey'))).toEqual([])
	const deleted = await deleteAccountSecret({
		...t.website(t.member()),
		fields: { currentId: 'user::::orgApiKey' },
	})
	expect(deleted.status).toBe(403)
	expect(deleted.data).toMatchObject({
		error: expect.stringContaining('You need Delete on this credential'),
	})
	const disconnected = await disconnectAccountSecret({
		...t.website(t.member()),
		fields: { currentId: 'user::::orgApiKey' },
	})
	expect(disconnected.status).toBe(403)
	expect(disconnected.data).toMatchObject({
		error: expect.stringContaining('You need Write on this credential'),
	})
	expect(await t.entry('orgApiKey')).not.toBeNull()

	await t.grantMember(id, ['secret:use', 'secret:write'])
	const allowed = await saveAccountSecret({
		...t.website(t.member()),
		fields: {
			currentId: 'user::::orgApiKey',
			name: 'orgApiKey',
			scope: 'user',
			value: 'replaced',
			allowedHosts: ['api.example.com'],
		},
	})
	expect(allowed.data).toMatchObject({ ok: true })
	expect(hostsOf(await t.entry('orgApiKey'))).toEqual(['api.example.com'])

	const renamed = await saveAccountSecret({
		...t.website(t.member()),
		fields: {
			currentId: 'user::::orgApiKey',
			name: 'renamedApiKey',
			scope: 'user',
			value: 'renamed',
			allowedHosts: ['api.example.com'],
		},
	})
	expect(renamed.data).toMatchObject({ ok: true })
	expect(await t.entry('renamedApiKey')).not.toBeNull()
})

test('moving an org credential to a package needs Delete on the source', async () => {
	const t = await setup()
	const id = await t.set('movableKey')
	await t.grantMember(id, ['secret:use', 'secret:write'])
	const moved = await saveAccountSecret({
		...t.website(t.member()),
		fields: {
			currentId: 'user::::movableKey',
			name: 'movableKey',
			scope: 'package',
			packageId,
			value: 'moved',
		},
	})
	expect(moved.status).toBe(403)
	expect(moved.data).toMatchObject({
		error: expect.stringContaining('You need Delete on this credential'),
	})
	expect(await t.entry('movableKey')).not.toBeNull()
})

test('a padded credential id is rejected before delete or disconnect', async () => {
	const t = await setup()
	await t.set('paddedKey')
	const deleted = await deleteAccountSecret({
		...t.website(t.owner),
		fields: { currentId: 'user::::paddedKey%20' },
	})
	expect(deleted.status).toBe(400)
	const disconnected = await disconnectAccountSecret({
		...t.website(t.owner),
		fields: { currentId: 'user::::%20paddedKey' },
	})
	expect(disconnected.status).toBe(400)
	expect(await t.entry('paddedKey')).not.toBeNull()
})

test('the owner still saves and deletes their own credentials on the website', async () => {
	const t = await setup()
	await t.set('ownKey')
	const saved = await saveAccountSecret({
		...t.website(t.owner),
		fields: {
			currentId: 'user::::ownKey',
			name: 'ownKey',
			scope: 'user',
			value: 'rotated',
			allowedHosts: ['api.example.com'],
		},
	})
	expect(saved.data).toMatchObject({ ok: true })
	const created = await saveAccountSecret({
		...t.website(t.owner),
		fields: { name: 'brandNew', scope: 'user', value: 'v' },
	})
	expect(created.data).toMatchObject({ ok: true })
	const deleted = await deleteAccountSecret({
		...t.website(t.owner),
		fields: { currentId: 'user::::ownKey' },
	})
	expect(deleted.data).toMatchObject({ ok: true, deleted: true })
})

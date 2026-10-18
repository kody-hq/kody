import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	deriveRequestContext,
	type EnablementRun,
	inheritRequest,
	type RequestSource,
} from '#worker/request-context/request-context.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

// These tests assert real `audit_events` rows written through the actual
// audit pipeline, so opt out of the shared audit-log-spy setup mock.
vi.unmock('#worker/audit-log.ts')
import { adminAuditLogQueryCapability } from './admin-audit-log-query.ts'
import { adminSystemEmailDeleteCapability } from './admin-system-email-delete.ts'
import { adminSystemEmailGetCapability } from './admin-system-email-get.ts'
import { adminSystemEmailListCapability } from './admin-system-email-list.ts'
import {
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import { adminUserUsageCapability } from './admin-user-usage.ts'
import { adminUserCreateCapability } from './admin-user-create.ts'
import { adminUserGetCapability } from './admin-user-get.ts'
import { adminUserListCapability } from './admin-user-list.ts'
import { adminUserUpdateCapability } from './admin-user-update.ts'
import { adminUserVerifyCapability } from './admin-user-verify.ts'
import { adminEmailDestinationVerifyCapability } from './admin-email-destination-verify.ts'
import { adminCreditWalletGetCapability } from './admin-credit-wallet-get.ts'
import { addEmailNotificationDestination } from '#worker/email/destinations.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'

const janeStableId = testStableUserIdFromEmail('jane@example.com')
const adminPersonId = personIdFromStored(
	testStableUserIdFromEmail('admin@example.com'),
)
const automationPackageId = 'pkg-admin-event-notify'
const roleIds = { user: 1, admin: 2 } as const

type SeedUser = {
	username: string
	roles: Array<keyof typeof roleIds>
	plan?: string
	emailVerifiedAt?: string | null
	createdAt: string
}

const admin: SeedUser = {
	username: 'admin',
	roles: ['admin', 'user'],
	emailVerifiedAt: '2026-01-01T00:00:00.000Z',
	createdAt: '2026-01-01 00:00:00',
}
const jane: SeedUser = {
	username: 'jane',
	roles: ['user'],
	createdAt: '2026-01-03 00:00:00',
}

function createMemoryEmailBlobs(seed: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(seed))
	return {
		store,
		blobs: {
			get: async (key: string) => {
				const value = store.get(key)
				if (value == null) return null
				return { text: async () => value }
			},
			put: async (key: string, value: string) => {
				store.set(key, value)
			},
			delete: async (key: string) => {
				store.delete(key)
			},
			head: async (key: string) => (store.has(key) ? { key } : null),
		},
	}
}

function createAdminCapabilityTest(
	users: Array<SeedUser>,
	blobs?: ReturnType<typeof createMemoryEmailBlobs>['blobs'],
	callerRoles: Array<string> = ['admin'],
	caller: { source?: RequestSource; packageId?: string | null } = {},
) {
	const callerPackageId =
		caller.packageId === undefined ? automationPackageId : caller.packageId
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const insertUser = sqlite.prepare(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'hash', ?, ?, ?, ?)`,
	)
	const insertOrg = sqlite.prepare(
		`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
	const insertRole = sqlite.prepare(
		`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
	)
	users.forEach((user, index) => {
		const email = `${user.username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		insertUser.run(
			index + 1,
			user.username,
			email,
			stableUserId,
			user.emailVerifiedAt ?? null,
			user.createdAt,
			user.createdAt,
		)
		insertOrg.run(
			stableUserId,
			user.username,
			user.plan ?? 'free',
			user.createdAt,
			user.createdAt,
		)
		for (const role of user.roles) insertRole.run(index + 1, roleIds[role])
	})
	const db = createD1FromSqlite(sqlite)
	const emailBlobs = blobs ?? createMemoryEmailBlobs().blobs
	const ctx = {
		env: {
			...createInMemoryRunLogUsageEnv().env,
			...createInMemoryUserMeterEnv().env,
			...createInMemoryRepoSessionIndexEnv(db),
			APP_DB: db,
			AUDIT_DB: createD1FromSqlite(auditSqlite),
			MAILBOX: {
				idFromName: (userId: string) =>
					({ userId }) as unknown as DurableObjectId,
				get: () => ({ countMessages: async () => ({ total: 0 }) }),
			},
			EMAIL_BLOBS: emailBlobs,
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: caller.source ?? { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: adminPersonId,
				email: 'admin@example.com',
				displayName: 'admin',
				roles: callerRoles,
			},
			storageContext: {
				sessionId: null,
				appId: callerPackageId,
				packageId: callerPackageId,
				storageId: null,
			},
		}),
	}
	return {
		db,
		sqlite,
		auditSqlite,
		ctx,
		auditEvents: () =>
			auditSqlite
				.prepare('SELECT action, result, reason FROM audit_events ORDER BY id')
				.all() as Array<{ action: string; result: string; reason: string }>,
		userRow: (email: string) =>
			sqlite
				.prepare(
					`SELECT u.id, u.email, u.stable_user_id, o.plan, u.email_verified_at
					 FROM users u
					 LEFT JOIN orgs o ON o.id = u.stable_user_id
					 WHERE u.email = ?`,
				)
				.get(email) as Record<string, unknown> | undefined,
	}
}

test('admin capabilities list and get account metadata and query sanitized audit rows', async () => {
	const t = createAdminCapabilityTest([admin, jane])

	const list = await adminUserListCapability.handler({ pageSize: 10 }, t.ctx)
	expect(list).toMatchObject({
		total: 2,
		page: 1,
		pageSize: 10,
		users: [
			expect.objectContaining({
				stableUserId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				email_verified: true,
				email_verified_at: '2026-01-01T00:00:00.000Z',
				roles: ['admin', 'user'],
			}),
			expect.objectContaining({
				stableUserId: janeStableId,
				email: 'jane@example.com',
				email_verified: false,
				email_verified_at: null,
				plan: 'free',
				manualPlan: 'free',
				stripePlan: null,
				effectivePlan: 'free',
				stripeCustomerLinked: false,
				roles: ['user'],
			}),
		],
	})

	const getByEmail = await adminUserGetCapability.handler(
		{ email: 'JANE@example.com' },
		t.ctx,
	)
	expect(getByEmail.user).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		email: 'jane@example.com',
		roles: ['user'],
	})

	const usage = await adminUserUsageCapability.handler(
		{ username: 'jane' },
		t.ctx,
	)
	expect(usage.usage).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		plan: 'free',
	})
	expect(usage.usage?.entitlementConsumption.length).toBeGreaterThan(0)
	await expect(
		adminUserUsageCapability.handler({ email: 'missing@example.com' }, t.ctx),
	).resolves.toEqual({ usage: null })

	// An invalid stable id must not fall through to the email lookup.
	await expect(
		loadAdminUserByTarget(t.db, {
			stableUserId: ownerIdFromStored('not-a-stable-id'),
			email: 'admin@example.com',
		}),
	).resolves.toBeNull()

	const audit = await adminAuditLogQueryCapability.handler(
		{ action: 'adminUserGet', limit: 10 },
		t.ctx,
	)
	expect(audit.total).toBe(1)
	expect(audit.events).toEqual([
		expect.objectContaining({
			action: 'adminUserGet',
			category: 'admin',
			result: 'success',
			email_hash: expect.any(String),
			reason: 'mcp_admin_capability',
		}),
	])
	expect(audit.events[0]).not.toHaveProperty('email')
	expect(t.auditEvents().map((event) => event.action)).toEqual([
		'adminUserList',
		'adminUserGet',
		'adminUserUsage',
		'adminUserUsage',
		'adminAuditLogQuery',
	])
})

test('adminAuditLogQuery accepts legacy SQLite rowids through output parse', async () => {
	const t = createAdminCapabilityTest([admin])
	const insertAudit = t.auditSqlite.prepare(
		`INSERT INTO audit_events (id, category, action, result, timestamp)
		 VALUES (?, 'admin', ?, 'success', '2026-01-01T00:00:00.000Z')`,
	)
	insertAudit.run(0, 'legacy_seed_zero')
	insertAudit.run(-1, 'legacy_seed_negative')

	const audit = await adminAuditLogQueryCapability.handler({ limit: 10 }, t.ctx)
	expect(audit.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 0,
				action: 'legacy_seed_zero',
				category: 'admin',
				result: 'success',
			}),
			expect.objectContaining({
				id: -1,
				action: 'legacy_seed_negative',
				category: 'admin',
				result: 'success',
			}),
		]),
	)
})

test('admin system email capabilities read only system-owned mail and audit reads', async () => {
	const rawMimeKey = emailRawMimeKey(systemEmailOwnerId, 'system-message-1')
	const memoryBlobs = createMemoryEmailBlobs({
		[rawMimeKey]: 'Subject: Abuse\r\n\r\nSystem body.',
	})
	const t = createAdminCapabilityTest([admin], memoryBlobs.blobs)
	t.sqlite.exec(
		`INSERT INTO email_inboxes (id, user_id, name, created_at, updated_at)
		 VALUES ('system-inbox-1', 'system:email', 'abuse', '2026-01-01', '2026-01-01')`,
	)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_messages (id, direction, inbox_id, from_address, envelope_from,
			   to_addresses_json, reply_to_addresses_json, headers_json, text_body, raw_mime_key,
			   subject, processing_status, raw_size, received_at, created_at, updated_at)
			 VALUES ('system-message-1', 'inbound', 'system-inbox-1', 'sender@example.net',
			   'bounce@example.net', '["abuse@example.com"]', '["sender@example.net"]',
			   '{"from":["Sender <sender@example.net>"]}', 'System body.', ?, 'Abuse report',
			   'stored', 32, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
			   '2026-01-03T00:00:00.000Z')`,
		)
		.run(rawMimeKey)

	const list = await adminSystemEmailListCapability.handler(
		{ pageSize: 10 },
		t.ctx,
	)
	expect(list.messages).toEqual([
		expect.objectContaining({
			id: 'system-message-1',
			inbox_local_part: 'abuse',
			subject: 'Abuse report',
			to_addresses: ['abuse@example.com'],
		}),
	])
	const get = await adminSystemEmailGetCapability.handler(
		{ id: 'system-message-1' },
		t.ctx,
	)
	expect(get.message).toMatchObject({
		id: 'system-message-1',
		text_body: 'System body.',
		raw_mime: 'Subject: Abuse\r\n\r\nSystem body.',
	})
	// User mail lives in per-user mailboxes, never in the system graph.
	await expect(
		adminSystemEmailGetCapability.handler({ id: 'user-message-1' }, t.ctx),
	).resolves.toEqual({ message: null })
	expect(t.auditEvents().map((event) => event.action)).toEqual([
		'adminSystemEmailList',
		'adminSystemEmailGet',
		'adminSystemEmailGet',
	])
	expect(t.auditEvents()[1]).toMatchObject({
		reason: 'target_message_id=system-message-1',
	})
})

test('adminSystemEmailDelete removes system mail graph rows and blobs, refuses non-admins and missing ids', async () => {
	const messageId = 'system-message-delete-1'
	const rawMimeKey = emailRawMimeKey(systemEmailOwnerId, messageId)
	const attachmentId = 'system-attachment-delete-1'
	const attachmentKey = emailAttachmentBlobKey(
		systemEmailOwnerId,
		messageId,
		attachmentId,
	)
	const memoryBlobs = createMemoryEmailBlobs({
		[rawMimeKey]: 'Subject: Phish\r\n\r\nOpen the rar.',
		[attachmentKey]: 'fake-rar-bytes',
	})
	const t = createAdminCapabilityTest([admin], memoryBlobs.blobs)
	t.sqlite.exec(
		`INSERT INTO email_inboxes (id, user_id, name, created_at, updated_at)
		 VALUES ('system-inbox-delete', 'system:email', 'kody', '2026-01-01', '2026-01-01');
		 INSERT INTO system_email_threads (
			id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
		 ) VALUES (
			'system-thread-delete', 'system-inbox-delete', 'gemini order',
			'2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'
		 );`,
	)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_messages (
				id, direction, inbox_id, thread_id, from_address, envelope_from,
				to_addresses_json, subject, text_body, raw_mime_key, processing_status,
				raw_size, received_at, created_at, updated_at
			) VALUES (
				?, 'inbound', 'system-inbox-delete', 'system-thread-delete',
				'phish@example.net', 'phish@example.net', '["kody@kody.codes"]',
				'Gemini Order No.206378105', 'Open the rar.', ?, 'stored', 64,
				'2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z'
			)`,
		)
		.run(messageId, rawMimeKey)
	t.sqlite
		.prepare(
			`INSERT INTO system_email_attachments (
				id, message_id, filename, content_type, size, storage_kind, storage_key, created_at
			) VALUES (?, ?, 'invoice.rar', 'application/x-rar-compressed', 12, 'external', ?, ?)`,
		)
		.run(attachmentId, messageId, attachmentKey, '2026-01-03T00:00:00.000Z')
	t.sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, fingerprint, detail_json,
				state, created_at
			) VALUES ('system-event-delete', ?, 'received', 'test', 'fp-delete', '{}',
				'received', ?)`,
		)
		.run(messageId, '2026-01-03T00:00:00.000Z')
	t.sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, fingerprint, detail_json,
				state, created_at
			) VALUES (
				'email-inbound-dedupe:fp-delete', NULL, 'receive_started',
				'cloudflare-email-routing-dedupe', 'fp-delete',
				json_object('messageId', ?), 'pending', ?
			)`,
		)
		.run(messageId, '2026-01-03T00:00:00.000Z')

	const nonAdmin = createAdminCapabilityTest([jane], memoryBlobs.blobs, [
		'user',
	])
	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: messageId },
			nonAdmin.ctx,
		),
	).rejects.toThrow(/admin/i)

	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: 'missing-system-message' },
			t.ctx,
		),
	).rejects.toThrow('System email message not found: missing-system-message')
	// User-owned mailbox ids are not on the system graph; refuse as not found.
	await expect(
		adminSystemEmailDeleteCapability.handler(
			{ message_id: 'user-message-1' },
			t.ctx,
		),
	).rejects.toThrow('System email message not found: user-message-1')

	const deleted = await adminSystemEmailDeleteCapability.handler(
		{ message_id: messageId },
		t.ctx,
	)
	expect(deleted).toEqual({
		ownerId: systemEmailOwnerId,
		deleted: true,
		message_id: messageId,
	})
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(messageId),
	).toBeUndefined()
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_attachments WHERE message_id = ?`)
			.all(messageId),
	).toEqual([])
	expect(
		t.sqlite
			.prepare(
				`SELECT id FROM system_email_delivery_events WHERE message_id = ?`,
			)
			.all(messageId),
	).toEqual([])
	expect(
		t.sqlite
			.prepare(
				`SELECT state, event_type, message_id
				FROM system_email_delivery_events
				WHERE id = 'email-inbound-dedupe:fp-delete'`,
			)
			.get(),
	).toEqual({
		state: 'rejected',
		event_type: 'rejected',
		message_id: null,
	})
	expect(
		t.sqlite
			.prepare(`SELECT id FROM system_email_threads WHERE id = ?`)
			.get('system-thread-delete'),
	).toBeUndefined()
	expect(memoryBlobs.store.has(rawMimeKey)).toBe(false)
	expect(memoryBlobs.store.has(attachmentKey)).toBe(false)
	expect(t.auditEvents().at(-1)).toMatchObject({
		action: 'adminSystemEmailDelete',
		result: 'success',
		reason: `target_message_id=${messageId}`,
	})
	expect(
		t
			.auditEvents()
			.some(
				(event) =>
					event.action === 'adminSystemEmailDelete' &&
					event.result === 'failure',
			),
	).toBe(true)
})

test('adminUserCreate records audit metadata and assigns the default role', async () => {
	const t = createAdminCapabilityTest([admin])

	const result = await adminUserCreateCapability.handler(
		{ email: 'Person+Launch@Example.com' },
		t.ctx,
	)
	const stableUserId = result.createdUser.stableUserId
	expect(stableUserId).toMatch(/^[a-f0-9]{64}$/)
	expect(stableUserId).not.toBe(
		testStableUserIdFromEmail('person+launch@example.com'),
	)

	expect(result.createdUser).toMatchObject({
		stableUserId,
		email: 'person+launch@example.com',
	})
	const created = t.userRow('person+launch@example.com')
	expect(created).toMatchObject({
		stable_user_id: stableUserId,
	})
	expect(
		t.sqlite
			.prepare(
				`SELECT o.plan FROM users u
				 INNER JOIN orgs o ON o.id = u.personal_org_id
				 WHERE u.email = ?`,
			)
			.get('person+launch@example.com'),
	).toEqual({ plan: 'free' })
	expect(
		t.sqlite
			.prepare(
				'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
			)
			.all(created?.['id'] as number)
			.map((row) => row['name']),
	).toEqual(['user'])
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserCreate',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId};target_email=***@example.com`,
		},
	])
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env: expect.anything(),
		source: 'admin',
		user: {
			id: stableUserId,
			username: result.createdUser.username,
			email: 'person+launch@example.com',
		},
	})
})

test('adminUserCreate rejects a username typed into the email field', async () => {
	const t = createAdminCapabilityTest([admin])
	await expect(
		adminUserCreateCapability.handler({ email: 'jjenzz' }, t.ctx),
	).rejects.toBeInstanceOf(McpCallerError)
	await expect(
		adminUserCreateCapability.handler({ email: 'jjenzz' }, t.ctx),
	).rejects.toThrow('Enter a valid email address, like name@gmail.com.')
	expect(t.sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get()).toEqual(
		{ count: 1 },
	)
})

test('adminUserUpdate sets plan, maps null clear to free, and rejects unknown users and plans', async () => {
	const t = createAdminCapabilityTest([admin, { ...jane, plan: 'max' }])
	const janePlan = () => t.userRow('jane@example.com')?.['plan']

	const setByEmail = await adminUserUpdateCapability.handler(
		{ email: 'JANE@example.com', plan: 'pro' },
		t.ctx,
	)
	expect(setByEmail.user).toMatchObject({
		stableUserId: janeStableId,
		username: 'jane',
		plan: 'pro',
		roles: ['user'],
	})
	expect(janePlan()).toBe('pro')

	const clearById = await adminUserUpdateCapability.handler(
		{ stableUserId: janeStableId, plan: null },
		t.ctx,
	)
	expect(clearById.user).toMatchObject({
		stableUserId: janeStableId,
		plan: 'free',
	})
	expect(janePlan()).toBe('free')

	await expect(
		adminUserUpdateCapability.handler(
			{ email: 'missing@example.com', plan: 'pro' },
			t.ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && error.message === 'User not found.',
	)
	await expect(
		adminUserUpdateCapability.handler(
			{ id: 1, plan: 'enterprise' } as never,
			t.ctx,
		),
	).rejects.toThrow('Invalid input for capability "adminUserUpdate"')
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserUpdate',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};plan=pro`,
		},
		{
			action: 'adminUserUpdate',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};plan=free`,
		},
		{
			action: 'adminUserUpdate',
			result: 'failure',
			reason: 'User not found.',
		},
	])
})

test('adminCreditWalletGet rejects unknown users as McpCallerError with audit failure', async () => {
	const t = createAdminCapabilityTest([admin, jane])

	await expect(
		adminCreditWalletGetCapability.handler(
			{ email: 'missing@example.com' },
			t.ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && error.message === 'User not found.',
	)
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminCreditWalletGet',
			result: 'failure',
			reason: 'User not found.',
		},
	])
})

test('adminEmailDestinationVerify marks an additional destination verified with audit metadata', async () => {
	const t = createAdminCapabilityTest([
		admin,
		{ ...jane, emailVerifiedAt: '2026-01-03T00:00:00.000Z' },
	])
	const janeRow = t.userRow('jane@example.com')
	expect(janeRow).toBeTruthy()
	const added = await addEmailNotificationDestination({
		db: t.db,
		dbUserId: Number(janeRow!['id']),
		email: 'pager@example.com',
	})
	expect(added.destination.verified).toBe(false)

	const marked = await adminEmailDestinationVerifyCapability.handler(
		{
			stableUserId: janeStableId,
			destinationEmail: 'pager@example.com',
		},
		t.ctx,
	)
	expect(marked.destination).toMatchObject({
		id: added.destination.id,
		email: 'pager@example.com',
		verified: true,
	})
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminEmailDestinationVerify',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};destination=pager@example.com`,
		},
	])
})

test('adminUserVerify marks verified and mints a one-time url with audit metadata', async () => {
	const t = createAdminCapabilityTest([admin, jane])

	const minted = await adminUserVerifyCapability.handler(
		{ email: 'JANE@example.com', action: 'mint_verify_url' },
		t.ctx,
	)
	expect(minted.user.email_verified).toBe(false)
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/example.com\/verify-email\?token=/,
	)
	expect(minted.expiresAt).toBeGreaterThan(Date.now())

	const verified = await adminUserVerifyCapability.handler(
		{ stableUserId: janeStableId, action: 'mark_verified' },
		t.ctx,
	)
	expect(verified.user.email_verified).toBe(true)
	expect(verified.verifyUrl).toBeNull()
	expect(t.userRow('jane@example.com')?.['email_verified_at']).toBeTruthy()

	await expect(
		adminUserVerifyCapability.handler(
			{ email: 'jane@example.com', action: 'mint_verify_url' },
			t.ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Email is already verified.',
	)
	await expect(
		adminUserVerifyCapability.handler(
			{ email: 'missing@example.com', action: 'mark_verified' },
			t.ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && error.message === 'User not found.',
	)
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserVerify',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};action=mint_verify_url`,
		},
		{
			action: 'adminUserVerify',
			result: 'success',
			reason: `target_stable_user_id=${janeStableId};action=mark_verified`,
		},
		{
			action: 'adminUserVerify',
			result: 'failure',
			reason: 'Email is already verified.',
		},
		{
			action: 'adminUserVerify',
			result: 'failure',
			reason: 'User not found.',
		},
	])
})

const adminEnablement: EnablementRun = {
	id: 'enablement-admin-notify',
	enabler: { userId: adminPersonId, username: 'admin' },
	role: 'owner',
}
const bea: SeedUser = {
	username: 'bea',
	roles: ['user'],
	createdAt: '2026-01-04 00:00:00',
}
const beaEnablement: EnablementRun = {
	...adminEnablement,
	enabler: {
		userId: personIdFromStored(testStableUserIdFromEmail('bea@example.com')),
		username: 'bea',
	},
	role: 'member',
}
const triggerAudit = (trigger: string, triggerId = adminEnablement.id) =>
	`trigger=${trigger};trigger_id=${triggerId};actor=${adminPersonId};package_id=${automationPackageId}`

const subscriptionRun = (
	enablement: EnablementRun = adminEnablement,
): RequestSource => ({
	kind: 'platform-event',
	sourceId: 'email_verification_stall_alert',
	enablement,
})

const triggeredAdminRuns: Array<{
	name: string
	source: RequestSource
	trigger: string
}> = [
	{
		name: 'job',
		source: { kind: 'schedule', jobId: 'job-1', enablement: adminEnablement },
		trigger: 'job',
	},
	{
		name: 'webhook',
		source: { kind: 'webhook', sourceId: 'ep-1', enablement: adminEnablement },
		trigger: 'webhook',
	},
	{ name: 'subscription', source: subscriptionRun(), trigger: 'subscription' },
	{
		name: 'inbound email',
		source: {
			kind: 'inbound-email',
			sourceId: 'message-1',
			sender: { kind: 'inbox-owner' },
			enablement: adminEnablement,
		},
		trigger: 'email',
	},
	{
		name: 'package code a subscription started',
		source: inheritRequest(
			deriveRequestContext({
				user: adminEnablement.enabler,
				source: subscriptionRun(),
			}),
		),
		trigger: 'subscription',
	},
]

test.each(triggeredAdminRuns)(
	'a $name run an admin enabled may call site-admin capabilities, and each call audits the trigger',
	async ({ source, trigger }) => {
		const t = createAdminCapabilityTest([admin, jane], undefined, ['admin'], {
			source,
		})
		const verified = await adminUserVerifyCapability.handler(
			{ email: 'jane@example.com', action: 'mark_verified' },
			t.ctx,
		)
		expect(verified.user.email_verified).toBe(true)
		await expect(
			adminUserVerifyCapability.handler(
				{ email: 'missing@example.com', action: 'mint_verify_url' },
				t.ctx,
			),
		).rejects.toThrow('User not found.')
		expect(t.auditEvents()).toEqual([
			{
				action: 'adminUserVerify',
				result: 'success',
				reason: `target_stable_user_id=${janeStableId};action=mark_verified`,
			},
			{
				action: 'adminUserVerify',
				result: 'success',
				reason: triggerAudit(trigger),
			},
			{
				action: 'adminUserVerify',
				result: 'failure',
				reason: 'User not found.',
			},
			{
				action: 'adminUserVerify',
				result: 'failure',
				reason: `${triggerAudit(trigger)};error=User not found.`,
			},
		])
	},
)

test('a triggered call that fails input validation still writes its trigger audit row', async () => {
	const t = createAdminCapabilityTest([admin, jane], undefined, ['admin'], {
		source: subscriptionRun(),
	})
	await expect(
		adminUserVerifyCapability.handler(
			{
				email: 'jane@example.com',
				username: 'jane',
				action: 'mark_verified',
			},
			t.ctx,
		),
	).rejects.toThrow('Invalid input for capability "adminUserVerify"')
	expect(t.auditEvents()).toEqual([
		{
			action: 'adminUserVerify',
			result: 'failure',
			reason: expect.stringMatching(
				new RegExp(
					`^${triggerAudit('subscription')};error=Invalid input for capability "adminUserVerify"`,
				),
			),
		},
	])
	expect(t.userRow('jane@example.com')?.['email_verified_at']).toBeNull()
})

const triggeredAdminRefusals: Array<{
	name: string
	source?: RequestSource
	roles?: Array<string>
	prepare?: (sqlite: DatabaseSync) => void
	error: RegExp
	denial: string
}> = [
	{
		name: 'enabler admin role revoked in D1 while cached roles still say admin',
		prepare: (sqlite) =>
			sqlite
				.prepare('DELETE FROM user_roles WHERE user_id = 1 AND role_id = ?')
				.run(roleIds.admin),
		error:
			/This subscription run acts for a person who lacks required role "admin" for capability "adminUserVerify"/,
		denial: 'role',
	},
	{
		name: 'enabler is not an admin',
		source: subscriptionRun(beaEnablement),
		error: /acts for a person who lacks required role "admin"/,
		denial: 'role',
	},
	{
		name: 'enabler is suspended',
		prepare: (sqlite) =>
			sqlite
				.prepare("UPDATE users SET suspended_at = '2026-10-01' WHERE id = 1")
				.run(),
		error: /This subscription run acts for no active person/,
		denial: 'no_user',
	},
	{
		name: 'trigger nobody turned on',
		source: { kind: 'platform-event', sourceId: 'event-1' },
		error: /This subscription run acts for no active person/,
		denial: 'no_user',
	},
	{
		name: 'package app visitor',
		source: { kind: 'package-app' },
		roles: [],
		error: /MCP user lacks required role "admin"/,
		denial: 'role',
	},
]

test.each(triggeredAdminRefusals)(
	'site-admin capabilities refuse a non-interactive run: $name',
	async (refusal) => {
		const t = createAdminCapabilityTest(
			[admin, jane, bea],
			undefined,
			refusal.roles ?? ['admin'],
			{ source: refusal.source ?? subscriptionRun() },
		)
		refusal.prepare?.(t.sqlite)
		await expect(
			adminUserVerifyCapability.handler(
				{ email: 'jane@example.com', action: 'mark_verified' },
				t.ctx,
			),
		).rejects.toThrow(refusal.error)
		expect(t.auditEvents()).toEqual([
			{
				action: 'mcp_capability_denied',
				result: 'failure',
				reason: refusal.denial,
			},
		])
		expect(t.userRow('jane@example.com')?.['email_verified_at']).toBeNull()
	},
)

test('a team-org triggered run with org caller roles still reaches site-admin when the enabler is admin (#3541)', async () => {
	const teamOrgId = testStableUserIdFromEmail('team-org@example.com')
	const source: RequestSource = {
		kind: 'schedule',
		jobId: 'job-team',
		enablement: adminEnablement,
	}
	const t = createAdminCapabilityTest([admin, jane], undefined, ['user'], {
		source,
	})
	t.ctx.callerContext = createMcpCallerContext({
		source,
		executionOrigin: 'background',
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(teamOrgId),
			email: '',
			username: 'team-org',
			displayName: 'Team Org',
			roles: ['user'],
		},
		storageContext: {
			sessionId: null,
			appId: automationPackageId,
			packageId: automationPackageId,
			storageId: null,
		},
	})
	expect(t.ctx.callerContext.request?.actor?.userId).toBe(adminPersonId)
	const verified = await adminUserVerifyCapability.handler(
		{ email: 'jane@example.com', action: 'mark_verified' },
		t.ctx,
	)
	expect(verified.user.email_verified).toBe(true)
})

test('a team-org jobRunNow with org caller roles reaches site-admin when the clicker is admin (#3541)', async () => {
	const teamOrgId = testStableUserIdFromEmail('team-org@example.com')
	const clickerLineage = createMcpCallerContext({
		source: { kind: 'session' },
		baseUrl: 'https://example.com',
		user: {
			userId: adminPersonId,
			email: 'admin@example.com',
			username: 'admin',
			displayName: 'admin',
			roles: ['admin'],
		},
	}).request!
	const source: RequestSource = {
		kind: 'inherited',
		lineage: clickerLineage,
	}
	const t = createAdminCapabilityTest([admin, jane], undefined, ['user'], {
		source,
	})
	t.ctx.callerContext = createMcpCallerContext({
		source,
		executionOrigin: 'background',
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(teamOrgId),
			email: '',
			username: 'team-org',
			displayName: 'Team Org',
			roles: ['user'],
		},
		storageContext: {
			sessionId: null,
			appId: automationPackageId,
			packageId: automationPackageId,
			storageId: null,
		},
	})
	expect(t.ctx.callerContext.request?.actor?.userId).toBe(adminPersonId)
	const verified = await adminUserVerifyCapability.handler(
		{ email: 'jane@example.com', action: 'mark_verified' },
		t.ctx,
	)
	expect(verified.user.email_verified).toBe(true)
	expect(t.auditEvents()).toEqual(
		expect.arrayContaining([
			{
				action: 'adminUserVerify',
				result: 'success',
				reason: triggerAudit('run-now', ''),
			},
		]),
	)
	// Team-org MCP user has no email; the wrapper row still hashes the clicker
	// so email-filtered audit queries find the run-now invocation.
	const runNowAudit = t.auditSqlite
		.prepare(
			`SELECT email_hash, reason FROM audit_events
			 WHERE action = 'adminUserVerify' AND reason LIKE 'trigger=run-now%'
			 ORDER BY id DESC LIMIT 1`,
		)
		.get() as { email_hash: string | null; reason: string } | undefined
	expect(runNowAudit?.reason).toBe(triggerAudit('run-now', ''))
	expect(runNowAudit?.email_hash).toBeTruthy()
})

test('an interactive caller without the admin role is still refused', async () => {
	const t = createAdminCapabilityTest([admin, jane], undefined, ['user'])
	await expect(
		adminUserVerifyCapability.handler(
			{ email: 'jane@example.com', action: 'mark_verified' },
			t.ctx,
		),
	).rejects.toThrow(
		/MCP user lacks required role "admin" for capability "adminUserVerify"/,
	)
	expect(t.userRow('jane@example.com')?.['email_verified_at']).toBeNull()
})

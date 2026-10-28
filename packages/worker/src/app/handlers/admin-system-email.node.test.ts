import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import {
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import { adminOperationOutcome } from '#worker/test-support/admin-operation-outcome.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<typeof AuthenticatedUser.readAuthenticatedAppUser>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const {
	blockAdminSystemEmailSender,
	classifyAdminSystemEmail,
	deleteAdminSystemEmail,
} = await import('#worker/admin/system-email-operations.ts')

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

function createActor(
	roles: Array<RoleName>,
): AuthenticatedUser.AuthenticatedAppUser {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: personIdFromStored('1'.padStart(64, '0')),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
		request: sessionRequestContext('1'.padStart(64, '0')),
	}
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

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const messageId = 'email-inbound-message:admin-delete-1'
	const rawMimeKey = emailRawMimeKey(systemEmailOwnerId, messageId)
	const attachmentId = 'admin-delete-attachment-1'
	const attachmentKey = emailAttachmentBlobKey(
		systemEmailOwnerId,
		messageId,
		attachmentId,
	)
	const memoryBlobs = createMemoryEmailBlobs({
		[rawMimeKey]: 'Subject: Phish\r\n\r\nOpen the rar.',
		[attachmentKey]: 'fake-rar-bytes',
	})
	sqlite.exec(
		`INSERT INTO email_inboxes (id, user_id, name, created_at, updated_at)
		 VALUES ('system-inbox-1', 'system:email', 'kody', '2026-01-01', '2026-01-01');
		 INSERT INTO system_email_threads (
			id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
		 ) VALUES (
			'system-thread-1', 'system-inbox-1', 'phish',
			'2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
			'2026-01-03T00:00:00.000Z'
		 );`,
	)
	sqlite
		.prepare(
			`INSERT INTO system_email_messages (
				id, direction, inbox_id, thread_id, from_address, to_addresses_json,
				subject, text_body, raw_mime_key, processing_status, raw_size,
				received_at, created_at, updated_at
			) VALUES (
				?, 'inbound', 'system-inbox-1', 'system-thread-1', 'phish@example.net',
				'["kody@kody.codes"]', 'Gemini Order No.206378105', 'Open the rar.', ?,
				'stored', 64, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
				'2026-01-03T00:00:00.000Z'
			)`,
		)
		.run(messageId, rawMimeKey)
	sqlite
		.prepare(
			`INSERT INTO system_email_attachments (
				id, message_id, filename, content_type, size, storage_kind, storage_key,
				created_at
			) VALUES (?, ?, 'invoice.rar', 'application/x-rar-compressed', 12, 'external',
				?, '2026-01-03T00:00:00.000Z')`,
		)
		.run(attachmentId, messageId, attachmentKey)
	sqlite
		.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, detail_json, created_at
			) VALUES ('system-event-1', ?, 'received', 'test', '{}',
				'2026-01-03T00:00:00.000Z')`,
		)
		.run(messageId)

	const env = {
		APP_DB: db,
		EMAIL_BLOBS: memoryBlobs.blobs,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const url = new URL('https://example.com/admin/system-email.json')
	const call = (input: {
		method?: string
		body?: Record<string, unknown>
		search?: string
		roles?: Array<RoleName>
	}) => {
		mockModule.readAuthenticatedAppUser.mockResolvedValue(
			createActor(input.roles ?? ['admin']),
		)
		const requestUrl = new URL(url)
		if (input.search) {
			requestUrl.search = input.search
		}
		return adminOperationOutcome(async () => {
			const request = new Request(requestUrl, {
				headers: { Accept: 'application/json' },
			})
			if (input.body)
				return deleteAdminSystemEmail({
					env,
					request,
					messageId:
						typeof input.body.message_id === 'string'
							? input.body.message_id
							: '',
				})
			const { requireUserWithRole } = await import('#app/permissions-server.ts')
			const actor = await requireUserWithRole(request, env, 'admin')
			const { loadAdminSystemEmailData } =
				await import('#worker/admin/system-email-data.ts')
			const { auditSystemEmailAccess } =
				await import('#worker/admin/system-email-operations.ts')
			const payload = await loadAdminSystemEmailData(env, requestUrl.toString())
			await auditSystemEmailAccess({
				env,
				request,
				actorEmail: actor.email,
				action: payload.selectedMessage
					? 'adminSystemEmailGet'
					: 'adminSystemEmailList',
				reason: payload.selectedMessage
					? `target_message_id=${payload.selectedMessage.id}`
					: 'system_email_list',
			})
			return payload
		})
	}
	const admin = async (
		run: (input: { env: Env; request: Request }) => Promise<unknown>,
		roles: Array<RoleName> = ['admin'],
	) => {
		mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(roles))
		return adminOperationOutcome(() =>
			run({
				env,
				request: new Request(url, { headers: { Accept: 'application/json' } }),
			}),
		)
	}
	return {
		sqlite,
		memoryBlobs,
		messageId,
		rawMimeKey,
		attachmentKey,
		call,
		admin,
	}
}

test('admin system email API lists, gets, and deletes operator-owned mail only', async () => {
	const { sqlite, memoryBlobs, messageId, rawMimeKey, attachmentKey, call } =
		createHarness()

	const list = await call({})
	expect(list.status).toBe(200)
	const listBody = (await Promise.resolve(list.data)) as {
		ok: boolean
		total: number
		messages: Array<{ id: string }>
	}
	expect(listBody).toMatchObject({
		ok: true,
		total: 1,
		messages: [{ id: messageId }],
	})

	const get = await call({
		search: `?messageId=${encodeURIComponent(messageId)}`,
	})
	expect(get.status).toBe(200)
	const getBody = (await Promise.resolve(get.data)) as {
		ok: boolean
		selectedMessage: { id: string; subject: string } | null
	}
	expect(getBody.selectedMessage).toMatchObject({
		id: messageId,
		subject: 'Gemini Order No.206378105',
	})

	const forbidden = await call({
		body: { action: 'delete', message_id: messageId },
		roles: ['user'],
	})
	expect(forbidden.status).toBe(403)

	const missing = await call({
		body: { action: 'delete', message_id: 'missing-id' },
	})
	expect(missing.status).toBe(404)

	const deleted = await call({
		body: { action: 'delete', message_id: messageId },
	})
	expect(deleted.status).toBe(200)
	expect(deleted.data).toEqual({ ok: true, deletedMessageId: messageId })
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_messages WHERE id = ?`)
			.get(messageId),
	).toBeUndefined()
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_attachments WHERE message_id = ?`)
			.all(messageId),
	).toEqual([])
	expect(
		sqlite
			.prepare(
				`SELECT id FROM system_email_delivery_events WHERE message_id = ?`,
			)
			.all(messageId),
	).toEqual([])
	expect(
		sqlite
			.prepare(`SELECT id FROM system_email_threads WHERE id = ?`)
			.get('system-thread-1'),
	).toBeUndefined()
	expect(memoryBlobs.store.has(rawMimeKey)).toBe(false)
	expect(memoryBlobs.store.has(attachmentKey)).toBe(false)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminSystemEmailDelete',
			result: 'success',
			reason: `target_message_id=${messageId}`,
		}),
	)
})

test('committed system email deletion does not depend on reloading the inbox', async () => {
	const { call, messageId } = createHarness()
	const data = await import('#worker/admin/system-email-data.ts')
	const read = vi
		.spyOn(data, 'loadAdminSystemEmailData')
		.mockRejectedValue(new Error('Inbox unavailable'))
	try {
		const deleted = await call({ body: { message_id: messageId } })
		expect(deleted.status).toBe(200)
		expect(deleted.data).toEqual({ ok: true, deletedMessageId: messageId })
		expect(read).not.toHaveBeenCalled()
	} finally {
		read.mockRestore()
	}
})

test('admin system email spam and archive are non-destructive, filtered, and audited', async () => {
	const { sqlite, messageId, call, admin } = createHarness()
	const listIds = async (search = '') => {
		const result = await call({ search })
		const body = (await Promise.resolve(result.data)) as {
			view: string
			total: number
			messages: Array<{
				id: string
				classification: string
				classification_reason: string | null
				archived_at: string | null
			}>
		}
		return body
	}

	expect(await listIds()).toMatchObject({
		view: 'inbox',
		total: 1,
		messages: [
			{ id: messageId, classification: 'accepted', archived_at: null },
		],
	})

	const forbidden = await admin(
		(input) =>
			classifyAdminSystemEmail({ ...input, messageId, classification: 'spam' }),
		['user'],
	)
	expect(forbidden.status).toBe(403)

	const spam = await admin((input) =>
		classifyAdminSystemEmail({ ...input, messageId, classification: 'spam' }),
	)
	expect(spam.status).toBe(200)
	expect(spam.data).toEqual({ ok: true, messageId, classification: 'spam' })
	expect(
		sqlite
			.prepare(
				`SELECT classification, classification_reason, archived_at
				 FROM system_email_messages WHERE id = ?`,
			)
			.get(messageId),
	).toEqual({
		classification: 'spam',
		classification_reason: 'Marked as spam.',
		archived_at: null,
	})
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminSystemEmailClassify',
			result: 'success',
			reason: `target_message_id=${messageId};classification=spam`,
		}),
	)
	expect((await listIds()).messages).toEqual([])
	expect((await listIds('?view=spam')).messages).toEqual([
		expect.objectContaining({
			id: messageId,
			classification: 'spam',
			classification_reason: 'Marked as spam.',
		}),
	])

	const blocked = await admin((input) =>
		blockAdminSystemEmailSender({ ...input, messageId }),
	)
	expect(blocked.status).toBe(200)
	expect(blocked.data).toMatchObject({
		ok: true,
		messageId,
		rule: { kind: 'address', value: 'phish@example.net' },
	})
	expect(
		sqlite
			.prepare(
				`SELECT kind, value, effect FROM email_sender_rules WHERE user_id = ?`,
			)
			.all(String(systemEmailOwnerId)),
	).toEqual([{ kind: 'address', value: 'phish@example.net', effect: 'block' }])
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminSystemEmailSenderRuleSet',
			result: 'success',
		}),
	)

	const restored = await admin((input) =>
		classifyAdminSystemEmail({
			...input,
			messageId,
			classification: 'accepted',
			archived: true,
		}),
	)
	expect(restored.status).toBe(200)
	const row = sqlite
		.prepare(
			`SELECT classification, classification_reason, archived_at
			 FROM system_email_messages WHERE id = ?`,
		)
		.get(messageId) as {
		classification: string
		classification_reason: string | null
		archived_at: string | null
	}
	expect(row.classification).toBe('accepted')
	expect(row.classification_reason).toBeNull()
	expect(row.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect((await listIds()).messages).toEqual([])
	expect((await listIds('?view=archived')).messages).toEqual([
		expect.objectContaining({ id: messageId, archived_at: row.archived_at }),
	])
	expect((await listIds('?view=all')).total).toBe(1)

	const unarchived = await admin((input) =>
		classifyAdminSystemEmail({ ...input, messageId, archived: false }),
	)
	expect(unarchived.data).toEqual({ ok: true, messageId, archived: false })
	expect((await listIds()).messages).toEqual([
		expect.objectContaining({ id: messageId, archived_at: null }),
	])

	const missing = await admin((input) =>
		classifyAdminSystemEmail({
			...input,
			messageId: 'missing-id',
			classification: 'spam',
		}),
	)
	expect(missing.status).toBe(404)
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: 'adminSystemEmailClassify',
			result: 'failure',
			reason: 'target_message_id=missing-id;classification=spam;not_found',
		}),
	)
	const empty = await admin((input) =>
		classifyAdminSystemEmail({ ...input, messageId }),
	)
	expect(empty.status).toBe(400)
	const missingSender = await admin((input) =>
		blockAdminSystemEmailSender({ ...input, messageId: 'missing-id' }),
	)
	expect(missingSender.status).toBe(404)

	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM system_email_attachments`)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM system_email_delivery_events`)
			.get(),
	).toEqual({ count: 1 })
})

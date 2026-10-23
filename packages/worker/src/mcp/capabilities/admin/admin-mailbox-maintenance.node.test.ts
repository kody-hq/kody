import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import type * as MailboxMaintenance from '#worker/admin/mailbox-maintenance.ts'
import {
	AdminMailboxMessageNotFoundError,
	adminMailboxMaintenanceRetentionMaxLimit,
} from '#worker/admin/mailbox-maintenance.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
	runAdminMailboxMaintenanceDeleteMessage: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Parameters<typeof AuditLog.logAuditEvent>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/admin/mailbox-maintenance.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxMaintenance>()
	return {
		...actual,
		runAdminMailboxMaintenanceDeleteMessage:
			mockModule.runAdminMailboxMaintenanceDeleteMessage,
	}
})

const { adminMailboxMaintenanceCapability } =
	await import('./admin-mailbox-maintenance.ts')

const emptyDeleteResult = {
	authoritativeMessageAbsent: true,
	attachmentsSeen: 2,
	externalAttachmentsSeen: 1,
	rawMimeBlobAbsent: true,
	externalAttachmentBlobsAbsent: 1,
	allCapturedBlobsAbsent: true,
}

function createAdminCtx() {
	const appSqlite = new DatabaseSync(':memory:')
	appSqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			personal_org_id TEXT,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			deleted_at TEXT
		);
	`)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(`
		CREATE TABLE audit_events (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			action TEXT NOT NULL,
			result TEXT NOT NULL,
			email_hash TEXT,
			ip_hash TEXT,
			client_id TEXT,
			path TEXT,
			reason TEXT,
			timestamp TEXT NOT NULL
		);
	`)
	return {
		env: {
			APP_DB: createD1FromSqlite(appSqlite),
			AUDIT_DB: createD1FromSqlite(auditSqlite),
		} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}
}

test('adminMailboxMaintenance deletes the system mail graph and audits the result', async () => {
	mockModule.runAdminMailboxMaintenanceDeleteMessage.mockResolvedValue(
		emptyDeleteResult,
	)
	const ctx = createAdminCtx()
	const stableUserId = testStableUserIdFromEmail('target@example.com')
	const messageId = 'canary-message-1'

	const deleted = await adminMailboxMaintenanceCapability.handler(
		{
			action: 'delete_message',
			stable_user_id: stableUserId,
			message_id: messageId,
		},
		ctx,
	)
	expect(deleted).toMatchObject({
		action: 'delete_message',
		result: {
			authoritativeMessageAbsent: true,
			allCapturedBlobsAbsent: true,
		},
	})
	expect(
		mockModule.runAdminMailboxMaintenanceDeleteMessage,
	).toHaveBeenCalledWith(expect.objectContaining({ stableUserId, messageId }))
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminMailboxMaintenance',
			result: 'success',
		}),
	)
	expect(JSON.stringify(deleted)).not.toMatch(
		/@example|secret body|email-raw:|email-attachment:/,
	)

	for (const invalid of [
		{ action: 'reconcile', batch_size: 101 },
		{
			action: 'retention',
			limit: adminMailboxMaintenanceRetentionMaxLimit + 1,
		},
		{ action: 'seed' },
		{
			action: 'delete_message',
			stable_user_id: 'not-a-stable-id',
			message_id: messageId,
		},
	]) {
		await expect(
			adminMailboxMaintenanceCapability.handler(invalid as never, ctx),
		).rejects.toThrow('Invalid input for capability "adminMailboxMaintenance"')
	}

	const notFound = new AdminMailboxMessageNotFoundError({
		stableUserId: ownerIdFromStored(stableUserId),
		messageId: 'already-gone',
	})
	mockModule.runAdminMailboxMaintenanceDeleteMessage.mockRejectedValueOnce(
		notFound,
	)
	await expect(
		adminMailboxMaintenanceCapability.handler(
			{
				action: 'delete_message',
				stable_user_id: stableUserId,
				message_id: 'already-gone',
			},
			ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && error.cause === notFound,
	)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminMailboxMaintenance',
			result: 'failure',
		}),
	)
})

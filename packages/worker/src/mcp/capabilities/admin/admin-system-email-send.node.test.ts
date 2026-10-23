import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn<typeof AuditLog.logAuditEvent>(async () => ({
		persisted: false,
		failedSinks: [],
	})),
	sendSystemEmail: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Parameters<typeof AuditLog.logAuditEvent>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/email/system-outbound.ts', () => ({
	maxSystemOutboundRecipients: 5,
	sendSystemEmail: mockModule.sendSystemEmail,
}))

const { adminSystemEmailSendCapability } =
	await import('./admin-system-email-send.ts')

function createAdminCtx(roles: Array<string> = ['admin']) {
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
		env: { AUDIT_DB: createD1FromSqlite(auditSqlite) } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(
					testStableUserIdFromEmail('admin@example.com'),
				),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles,
			},
		}),
	}
}

test('adminSystemEmailSend is admin-gated, validates input, and audits a redacted send', async () => {
	const ctx = createAdminCtx()
	mockModule.sendSystemEmail.mockClear()
	await expect(
		adminSystemEmailSendCapability.handler(
			{
				to: 'reporter@example.com',
				subject: 'No body',
				text: 'Body',
			},
			createAdminCtx(['user']),
		),
	).rejects.toThrow(/lacks required role/)

	await expect(
		adminSystemEmailSendCapability.handler(
			{ to: 'reporter@example.com', subject: 'No body' },
			ctx,
		),
	).rejects.toThrow(/text/iu)

	await expect(
		adminSystemEmailSendCapability.handler(
			{
				to: Array.from({ length: 6 }, (_, index) => `r${index}@example.com`),
				subject: 'Too many',
				text: 'Body',
			},
			ctx,
		),
	).rejects.toThrow('Invalid input for capability "adminSystemEmailSend"')
	expect(mockModule.sendSystemEmail).not.toHaveBeenCalled()

	mockModule.sendSystemEmail.mockResolvedValue({
		from: 'support@heykody.dev',
		to: ['reporter@example.com'],
		providerMessageId: 'provider-1',
	})

	const result = await adminSystemEmailSendCapability.handler(
		{
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			from_local: 'support',
		},
		ctx,
	)

	expect(result).toEqual({
		from: 'support@heykody.dev',
		to: ['reporter@example.com'],
		provider_message_id: 'provider-1',
	})
	expect(mockModule.sendSystemEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			localPart: 'support',
			to: 'reporter@example.com',
			subject: 'Thanks for the report',
			text: 'We shipped the fix.',
			html: null,
			replyTo: null,
			waitUntil: undefined,
		}),
	)
	const auditCall = mockModule.logAuditEvent.mock.calls.at(-1)?.[0] as
		| { action: string; result: string; reason: string }
		| undefined
	expect(auditCall?.action).toBe('adminSystemEmailSend')
	expect(auditCall?.result).toBe('success')
	expect(auditCall?.reason).toContain('from=support@heykody.dev')
	// Recipients are redacted in audit rows, never stored in the clear.
	expect(auditCall?.reason).not.toContain('reporter@example.com')
})

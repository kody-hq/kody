import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as EmailService from '#worker/email/service.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	setEmailMessageClassification:
		vi.fn<typeof EmailService.setEmailMessageClassification>(),
}))

vi.mock('#worker/email/service.ts', () => ({
	setEmailMessageClassification: mocks.setEmailMessageClassification,
}))

const { adminSystemEmailClassifyCapability } =
	await import('./admin-system-email-classify.ts')

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('admin-user'),
				username: 'admin',
				email: 'admin@example.com',
				displayName: 'Admin',
				roles,
			},
		}),
	}
}

test('adminSystemEmailClassify requires admin and never touches mail for non-admins', async () => {
	await expect(
		adminSystemEmailClassifyCapability.handler(
			{ message_id: 'system-message-1', classification: 'spam' },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mocks.setEmailMessageClassification).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
		}),
	)
})

test('adminSystemEmailClassify marks spam and archives on systemEmailOwnerId with audits', async () => {
	const ctx = createContext(['admin'])
	mocks.setEmailMessageClassification.mockResolvedValue(true)

	await expect(
		adminSystemEmailClassifyCapability.handler(
			{ message_id: 'system-message-1', classification: 'spam' },
			ctx,
		),
	).resolves.toEqual({
		ownerId: systemEmailOwnerId,
		message_id: 'system-message-1',
		classification: 'spam',
	})
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith({
		env: ctx.env,
		db: ctx.env.APP_DB,
		userId: systemEmailOwnerId,
		messageId: 'system-message-1',
		classification: 'spam',
		classificationReason: 'Marked as spam.',
		archived: undefined,
	})
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminSystemEmailClassify',
			result: 'success',
			reason: 'target_message_id=system-message-1;classification=spam',
		}),
	)

	await expect(
		adminSystemEmailClassifyCapability.handler(
			{ message_id: 'system-message-1', archived: true },
			ctx,
		),
	).resolves.toEqual({
		ownerId: systemEmailOwnerId,
		message_id: 'system-message-1',
		archived: true,
	})
	expect(
		mocks.setEmailMessageClassification.mock.lastCall?.[0],
	).not.toHaveProperty('classification')

	await adminSystemEmailClassifyCapability.handler(
		{ message_id: 'system-message-1', classification: 'accepted' },
		ctx,
	)
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith(
		expect.objectContaining({
			classification: 'accepted',
			classificationReason: null,
		}),
	)

	mocks.setEmailMessageClassification.mockResolvedValueOnce(false)
	await expect(
		adminSystemEmailClassifyCapability.handler(
			{ message_id: 'missing', archived: false },
			ctx,
		),
	).rejects.toThrow('System email message not found: missing')

	expect(auditEventSummaries()).toEqual([
		'adminSystemEmailClassify:success',
		'adminSystemEmailClassify:success',
		'adminSystemEmailClassify:success',
		'adminSystemEmailClassify:failure',
	])
	mocks.setEmailMessageClassification.mockReset()
})

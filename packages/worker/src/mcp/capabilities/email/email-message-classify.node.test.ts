import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const mocks = vi.hoisted(() => ({
	setEmailMessageClassification: vi.fn(),
}))

vi.mock('#worker/email/service.ts', () => ({
	setEmailMessageClassification: mocks.setEmailMessageClassification,
}))

vi.mock('#worker/email/authorize-email-message.ts', () => ({
	authorizeEmailMessageChange: async (input: { messageId: string }) => ({
		id: input.messageId,
	}),
}))

const { emailMessageClassifyCapability, emailMessageTriageInputSchema } =
	await import('./email-message-classify.ts')

function createContext() {
	return {
		env: {
			APP_DB: {
				prepare: () => ({
					bind: () => ({
						first: async () => ({
							email_verified_at: '2026-01-01T00:00:00.000Z',
						}),
					}),
				}),
			} as unknown as D1Database,
		} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User Example',
			},
		}),
	}
}

test('emailMessageClassify sets classification reasons and maps missing messages', async () => {
	const context = createContext()
	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)

	await emailMessageClassifyCapability.handler(
		{ message_id: 'message-1', classification: 'quarantined' },
		context,
	)
	expect(mocks.setEmailMessageClassification).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			classificationReason: 'Reclassified by user.',
		}),
	)

	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)
	await emailMessageClassifyCapability.handler(
		{ message_id: 'message-1', classification: 'accepted' },
		context,
	)
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith(
		expect.objectContaining({ classificationReason: null }),
	)

	mocks.setEmailMessageClassification.mockResolvedValueOnce(false)
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'missing', classification: 'quarantined' },
			context,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Email message not found: missing',
	)
})

test('emailMessageClassify marks spam, archives independently, and audits each change', async () => {
	const context = createContext()
	mocks.setEmailMessageClassification.mockResolvedValue(true)

	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'message-1', classification: 'spam' },
			context,
		),
	).resolves.toEqual({ message_id: 'message-1', classification: 'spam' })
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith(
		expect.objectContaining({
			messageId: 'message-1',
			classification: 'spam',
			classificationReason: 'Marked as spam.',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'emailMessageClassify',
			result: 'success',
			path: '/mcp',
			reason: 'target_message_id=message-1;classification=spam',
		}),
	)

	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'message-1', archived: true },
			context,
		),
	).resolves.toEqual({ message_id: 'message-1', archived: true })
	const archiveCall = mocks.setEmailMessageClassification.mock.lastCall?.[0]
	expect(archiveCall).toMatchObject({ messageId: 'message-1', archived: true })
	expect(archiveCall).not.toHaveProperty('classification')
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			reason: 'target_message_id=message-1;archived=true',
		}),
	)

	await emailMessageClassifyCapability.handler(
		{ message_id: 'message-1', classification: 'accepted', archived: false },
		context,
	)
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith(
		expect.objectContaining({
			classification: 'accepted',
			classificationReason: null,
			archived: false,
		}),
	)

	mocks.setEmailMessageClassification.mockResolvedValueOnce(false)
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'missing', archived: true },
			context,
		),
	).rejects.toThrow('Email message not found: missing')
	expect(logAuditEventSpy).toHaveBeenLastCalledWith(
		expect.objectContaining({
			result: 'failure',
			reason: 'target_message_id=missing;archived=true;not_found',
		}),
	)
	mocks.setEmailMessageClassification.mockReset()
})

test('emailMessageClassify requires classification or archived', () => {
	const schema = emailMessageTriageInputSchema
	expect(schema.safeParse({ message_id: 'message-1' }).success).toBe(false)
	expect(
		schema.safeParse({ message_id: 'message-1', classification: 'junk' })
			.success,
	).toBe(false)
	expect(
		schema.safeParse({ message_id: 'message-1', archived: false }).success,
	).toBe(true)
	expect(
		schema.safeParse({ message_id: 'message-1', classification: 'spam' })
			.success,
	).toBe(true)
})

test('emailMessageClassify refuses the operator system inbox', async () => {
	const context = createContext()
	const request = context.callerContext.request!
	const systemContext = {
		...context,
		callerContext: {
			...context.callerContext,
			request: { ...request, org: { ...request.org, id: systemEmailOwnerId } },
		},
	}
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'system-message', classification: 'spam' },
			systemContext,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('adminSystemEmailClassify'),
	)
	expect(mocks.setEmailMessageClassification).not.toHaveBeenCalled()
})

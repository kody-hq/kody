import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	setEmailMessageClassification: vi.fn(),
}))

vi.mock('#worker/email/service.ts', () => ({
	setEmailMessageClassification: mocks.setEmailMessageClassification,
}))

const { emailMessageClassifyCapability } =
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

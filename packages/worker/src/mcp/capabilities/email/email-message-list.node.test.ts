import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	listOwnerEmailMessages: vi.fn(),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessages: mocks.listOwnerEmailMessages,
}))

const { emailMessageListCapability } = await import('./email-message-list.ts')

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

test('emailMessageList scopes the read to the signed-in owner', async () => {
	const context = createContext()
	mocks.listOwnerEmailMessages.mockResolvedValue([])
	await emailMessageListCapability.handler(
		{ classification: 'quarantined', limit: 10 },
		context,
	)
	expect(mocks.listOwnerEmailMessages).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: ownerIdFromStored('user-1'),
		}),
	)
})

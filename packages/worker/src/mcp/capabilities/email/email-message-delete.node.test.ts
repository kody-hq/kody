import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	deleteEmailMessage: vi.fn(),
}))

vi.mock('#worker/email/service.ts', () => ({
	deleteEmailMessage: mocks.deleteEmailMessage,
}))

vi.mock('#worker/email/authorize-email-message.ts', () => ({
	authorizeEmailMessageChange: async (input: { messageId: string }) => ({
		id: input.messageId,
	}),
}))

const { emailMessageDeleteCapability } =
	await import('./email-message-delete.ts')

function createUsersDb(emailVerifiedAt: string | null) {
	return {
		prepare: () => ({
			bind: () => ({
				first: async () => ({ email_verified_at: emailVerifiedAt }),
			}),
		}),
	} as unknown as D1Database
}

function createEnv(options: { emailVerifiedAt?: string | null } = {}) {
	return {
		APP_DB: createUsersDb(
			options.emailVerifiedAt === undefined
				? '2026-01-01T00:00:00.000Z'
				: options.emailVerifiedAt,
		),
	} as Env
}

function createUserContext(userId = 'user-1') {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: 'User Example',
		},
	})
}

test('emailMessageDelete requires a signed-in, verified owner and deletes that message', async () => {
	await expect(
		emailMessageDeleteCapability.handler(
			{ message_id: 'message-1' },
			{
				env: createEnv(),
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)

	await expect(
		emailMessageDeleteCapability.handler(
			{ message_id: 'message-1' },
			{
				env: createEnv({ emailVerifiedAt: null }),
				callerContext: createUserContext(),
			},
		),
	).rejects.toThrow(/Account email is not verified/)
	expect(mocks.deleteEmailMessage).not.toHaveBeenCalled()

	const env = createEnv()
	mocks.deleteEmailMessage.mockResolvedValueOnce(true)
	await expect(
		emailMessageDeleteCapability.handler(
			{ message_id: 'message-1' },
			{ env, callerContext: createUserContext() },
		),
	).resolves.toEqual({
		deleted: true,
		message_id: 'message-1',
	})
	expect(mocks.deleteEmailMessage).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
	})
})

test('emailMessageDelete fails fast on missing or foreign message ids', async () => {
	const env = createEnv()
	mocks.deleteEmailMessage.mockResolvedValueOnce(false)

	await expect(
		emailMessageDeleteCapability.handler(
			{ message_id: 'foreign-or-missing' },
			{ env, callerContext: createUserContext('user-1') },
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === 'Email message not found: foreign-or-missing',
	)
	expect(mocks.deleteEmailMessage).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored('user-1'),
		messageId: 'foreign-or-missing',
	})
})

import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	searchOwnerEmailMessages: vi.fn(),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	searchOwnerEmailMessages: (...args: Array<unknown>) =>
		mockModule.searchOwnerEmailMessages(...args),
}))

const { emailMessageSearchCapability } =
	await import('./email-message-search.ts')
const { createMcpCallerContext } = await import('#mcp/context.ts')

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

function createUserContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
}

test('emailMessageSearch requires a signed-in, verified user and forwards the query scoped to that user', async () => {
	await expect(
		emailMessageSearchCapability.handler(
			{ query: 'invoice', limit: 25 },
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
		emailMessageSearchCapability.handler(
			{ query: 'invoice', limit: 25 },
			{
				env: createEnv({ emailVerifiedAt: null }),
				callerContext: createUserContext(),
			},
		),
	).rejects.toThrow(/Account email is not verified/)
	expect(mockModule.searchOwnerEmailMessages).not.toHaveBeenCalled()

	const env = createEnv()
	mockModule.searchOwnerEmailMessages.mockResolvedValueOnce([
		{
			id: 'message-1',
			direction: 'inbound',
			inboxId: 'inbox-1',
			threadId: null,
			fromAddress: 'billing@acme.example',
			envelopeFrom: 'bounce@acme.example',
			toAddresses: ['alias@example.com'],
			subject: 'Invoice #123',
			messageIdHeader: '<invoice@acme.example>',
			processingStatus: 'stored',
			classification: 'accepted',
			classificationReason: null,
			archivedAt: null,
			providerMessageId: null,
			error: null,
			receivedAt: '2026-07-01T00:00:00.000Z',
			sentAt: null,
			createdAt: '2026-07-01T00:00:00.000Z',
			updatedAt: '2026-07-01T00:00:00.000Z',
		},
	])

	const result = await emailMessageSearchCapability.handler(
		{
			query: 'invoice',
			inbox_id: 'inbox-1',
			direction: 'inbound',
			limit: 10,
		},
		{ env, callerContext: createUserContext() },
	)

	expect(mockModule.searchOwnerEmailMessages).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('user-1'),
		query: 'invoice',
		inboxId: 'inbox-1',
		direction: 'inbound',
		processingStatus: null,
		deliveryStatus: null,
		view: 'inbox',
		limit: 10,
	})
	expect(result.messages).toEqual([
		expect.objectContaining({
			id: 'message-1',
			subject: 'Invoice #123',
			from_address: 'billing@acme.example',
			envelope_from: 'bounce@acme.example',
		}),
	])
})

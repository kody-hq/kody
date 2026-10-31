import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	sendOutboundEmail: vi.fn(),
}))

vi.mock('#worker/email/outbound.ts', () => ({
	maxOutboundEmailAttachments: 10,
	sendOutboundEmail: mocks.sendOutboundEmail,
}))

const { emailSendCapability } = await import('./email-send.ts')

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
			},
		} as unknown as Env,
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

function sentMessage(id = 'outbound-1') {
	return {
		id,
		direction: 'outbound',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		fromAddress: 'user@heykody.dev',
		envelopeFrom: 'user@heykody.dev',
		toAddresses: ['user@example.com'],
		subject: 'Hello',
		messageIdHeader: '<outbound@heykody.dev>',
		processingStatus: 'sent',
		classification: 'accepted',
		classificationReason: null,
		archivedAt: null,
		providerMessageId: 'provider-1',
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: null,
		sentAt: '2026-05-13T07:30:16.000Z',
		createdAt: '2026-05-13T07:30:16.000Z',
		updatedAt: '2026-05-13T07:30:16.000Z',
	}
}

test('emailSend forwards optional attachments and rejects invalid attachment shapes', async () => {
	mocks.sendOutboundEmail.mockResolvedValue({
		status: 'sent',
		error: null,
		providerMessageId: 'provider-1',
		message: sentMessage(),
	})

	const withoutAttachments = await emailSendCapability.handler(
		{
			subject: 'Hello',
			text: 'Body',
		},
		createContext(),
	)
	expect(withoutAttachments).toMatchObject({
		provider_message_id: 'provider-1',
		status: 'sent',
		error: null,
		message: { id: 'outbound-1', subject: 'Hello' },
	})
	expect(mocks.sendOutboundEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			actorPersonId: personIdFromStored('user-1'),
			accountEmail: 'user@example.com',
			recipientPolicy: 'self',
			to: null,
			subject: 'Hello',
			text: 'Body',
			html: null,
			replyTo: null,
			attachments: undefined,
		}),
	)

	await emailSendCapability.handler(
		{
			to: ['user@example.com', 'phone@example.com'],
			subject: 'Report',
			text: 'Report attached.',
			attachments: [
				{
					filename: 'report.csv',
					content_type: 'text/csv',
					content_base64: 'bmFtZSx0b3RhbA==',
				},
			],
		},
		createContext(),
	)
	expect(mocks.sendOutboundEmail).toHaveBeenLastCalledWith(
		expect.objectContaining({
			recipientPolicy: 'self',
			to: ['user@example.com', 'phone@example.com'],
			attachments: [
				{
					filename: 'report.csv',
					contentType: 'text/csv',
					contentBase64: 'bmFtZSx0b3RhbA==',
				},
			],
		}),
	)

	const invalidAttachmentLists = [
		[{ content_type: 'text/plain', content_base64: 'aGVsbG8=' }],
		[],
		Array.from({ length: 11 }, (_, index) => ({
			filename: `file-${index}.txt`,
			content_type: 'text/plain',
			content_base64: 'aGVsbG8=',
		})),
	]
	for (const attachments of invalidAttachmentLists) {
		const error = await emailSendCapability
			.handler(
				{ subject: 'Hello', text: 'Body', attachments } as never,
				createContext(),
			)
			.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toContain(
			'Invalid input for capability "emailSend"',
		)
	}

	expect(mocks.sendOutboundEmail).toHaveBeenCalledTimes(2)
})

test('emailSend forwards an explicit from alias to the outbound sender', async () => {
	mocks.sendOutboundEmail.mockResolvedValue({
		status: 'sent',
		error: null,
		providerMessageId: 'provider-2',
		message: sentMessage('outbound-2'),
	})
	await emailSendCapability.handler(
		{
			subject: 'Hello',
			text: 'Body',
			from: 'examplebot+support@inbox.kody.codes',
		},
		createContext(),
	)
	expect(mocks.sendOutboundEmail).toHaveBeenLastCalledWith(
		expect.objectContaining({
			recipientPolicy: 'self',
			from: 'examplebot+support@inbox.kody.codes',
			replyTo: null,
		}),
	)
})

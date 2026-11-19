import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	listOwnerEmailDeliveryEvents: vi.fn(),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailDeliveryEvents: mocks.listOwnerEmailDeliveryEvents,
	getOwnerEmailMessageById: async () => ({ id: 'message-1', inboxId: null }),
}))

const { emailDeliveryEventListCapability } =
	await import('./email-delivery-event-list.ts')

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

test('emailDeliveryEventList returns parsed events scoped to the signed-in user', async () => {
	mocks.listOwnerEmailDeliveryEvents.mockResolvedValueOnce([
		{
			id: 'event-1',
			messageId: 'message-1',
			userId: ownerIdFromStored('user-1'),
			inboxId: null,
			eventType: 'bounced',
			provider: 'cloudflare-email',
			providerMessageId: 'provider-1',
			providerEventId: 'provider-event-1',
			detailJson: JSON.stringify({
				delivery: { status: 'bounced', smtpStatusCode: '550' },
			}),
			createdAt: '2026-07-17T20:00:00.000Z',
		},
	])

	const context = createContext()
	const result = await emailDeliveryEventListCapability.handler(
		{ message_id: 'message-1', event_type: 'bounced', limit: 10 },
		context,
	)

	expect(mocks.listOwnerEmailDeliveryEvents).toHaveBeenCalledWith({
		env: context.env,
		ownerId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
		eventType: 'bounced',
		limit: 10,
	})
	expect(result.events).toEqual([
		{
			id: 'event-1',
			message_id: 'message-1',
			inbox_id: null,
			event_type: 'bounced',
			provider: 'cloudflare-email',
			provider_message_id: 'provider-1',
			provider_event_id: 'provider-event-1',
			detail: {
				delivery: { status: 'bounced', smtpStatusCode: '550' },
			},
			created_at: '2026-07-17T20:00:00.000Z',
		},
	])
})

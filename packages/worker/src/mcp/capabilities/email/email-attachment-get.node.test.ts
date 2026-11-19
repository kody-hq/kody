import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getOwnerEmailAttachmentById: vi.fn(),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	getOwnerEmailAttachmentById: (...args: Array<unknown>) =>
		mockModule.getOwnerEmailAttachmentById(...args),
	getOwnerEmailMessageById: async () => ({ id: 'message-1', inboxId: null }),
}))

const { emailAttachmentGetCapability } =
	await import('./email-attachment-get.ts')
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

test('email capabilities require a signed-in user and return attachment content or reject missing ids', async () => {
	await expect(
		emailAttachmentGetCapability.handler(
			{ attachment_id: 'attachment-1' },
			{
				env: { APP_DB: {} } as Env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	const verifiedDb = createUsersDb('2026-01-01T00:00:00.000Z')
	const env = {
		APP_DB: verifiedDb,
		EMAIL_BLOBS: {} as R2Bucket,
	} as Env

	await expect(
		emailAttachmentGetCapability.handler(
			{ attachment_id: 'attachment-1' },
			{
				env: { APP_DB: createUsersDb(null) } as Env,
				callerContext,
			},
		),
	).rejects.toThrow(/Account email is not verified/)
	expect(mockModule.getOwnerEmailAttachmentById).not.toHaveBeenCalled()

	mockModule.getOwnerEmailAttachmentById.mockResolvedValueOnce({
		id: 'attachment-1',
		messageId: 'message-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 12,
		storageKind: 'raw-mime',
		storageKey: null,
		createdAt: '2026-04-30T00:00:00.000Z',
		contentBase64: 'QXR0YWNobWVudCB0ZXh0',
	})

	const result = await emailAttachmentGetCapability.handler(
		{ attachment_id: 'attachment-1' },
		{ env, callerContext },
	)

	expect(mockModule.getOwnerEmailAttachmentById).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('user-1'),
		blobs: env.EMAIL_BLOBS,
		attachmentId: 'attachment-1',
	})
	expect(result).toEqual({
		id: 'attachment-1',
		message_id: 'message-1',
		filename: 'note.txt',
		content_type: 'text/plain',
		content_id: null,
		disposition: 'attachment',
		size: 12,
		data_base64: 'QXR0YWNobWVudCB0ZXh0',
	})

	mockModule.getOwnerEmailAttachmentById.mockResolvedValueOnce(null)

	await expect(
		emailAttachmentGetCapability.handler(
			{ attachment_id: 'missing-attachment' },
			{ env, callerContext },
		),
	).rejects.toThrow('Email attachment not found: missing-attachment')
})

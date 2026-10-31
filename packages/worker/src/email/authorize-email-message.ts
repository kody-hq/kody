import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { authorize, authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { getOwnerEmailMessageById } from './owner-email-reader.ts'
import { getEmailInboxById } from './repo.ts'
import { type EmailMessageRecord } from './types.ts'

/**
 * Loads one stored message for a delete or triage and checks `permission` on
 * the message's own inbox: a grant on another inbox is not enough. A message
 * with no inbox needs the permission org-wide. Returns null when the message
 * does not exist in this owner's mailbox.
 */
export async function authorizeEmailMessageChange(input: {
	env: Env
	request: RequestContext | null
	ownerId: OwnerId
	messageId: string
	permission: 'email:delete' | 'email:write'
}): Promise<EmailMessageRecord | null> {
	const ctx = { env: input.env, request: input.request }
	await authorize(ctx, input.permission)
	const message = await getOwnerEmailMessageById({
		env: input.env,
		ownerId: input.ownerId,
		messageId: input.messageId,
	})
	if (!message) return null
	if (!message.inboxId) {
		await authorizeOrgWide(ctx, input.permission)
		return message
	}
	const inbox = await getEmailInboxById({
		db: input.env.APP_DB,
		userId: input.ownerId,
		id: message.inboxId,
	})
	await authorize(ctx, input.permission, {
		type: 'email',
		id: message.inboxId,
		orgId: input.ownerId,
		label: inbox ? `inbox "${inbox.name}"` : 'inbox',
	})
	return message
}

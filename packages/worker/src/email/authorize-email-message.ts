import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	authorize,
	authorizeOrgWide,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { getOwnerEmailMessageById } from './owner-email-reader.ts'
import { getEmailInboxById } from './repo.ts'
import type { EmailMessageRecord } from './types.ts'

type EmailMessagePermission =
	| 'email:read'
	| 'email:send'
	| 'email:delete'
	| 'email:write'

/**
 * Checks `permission` on the inbox a stored message belongs to: a grant on
 * another inbox is not enough. A message with no inbox needs the permission
 * org-wide.
 */
export async function authorizeEmailMessageInbox(input: {
	env: Env
	request: RequestContext | null
	ownerId: OwnerId
	message: Pick<EmailMessageRecord, 'inboxId'>
	permission: EmailMessagePermission
}) {
	const ctx = { env: input.env, request: input.request }
	const inboxId = input.message.inboxId
	if (!inboxId) {
		await authorizeOrgWide(ctx, input.permission)
		return
	}
	const inbox = await getEmailInboxById({
		db: input.env.APP_DB,
		userId: input.ownerId,
		id: inboxId,
	})
	await authorize(ctx, input.permission, {
		type: 'email',
		id: inboxId,
		orgId: input.ownerId,
		label: inbox ? `inbox "${inbox.name}"` : 'inbox',
	})
}

/**
 * Checks `permission` before looking up the message, then checks it on the
 * message's inbox. Returns null if the lookup finds no message.
 */
export async function authorizeEmailMessageChange(input: {
	env: Env
	request: RequestContext | null
	ownerId: OwnerId
	messageId: string
	permission: EmailMessagePermission
}): Promise<EmailMessageRecord | null> {
	await authorize({ env: input.env, request: input.request }, input.permission)
	const message = await getOwnerEmailMessageById({
		env: input.env,
		ownerId: input.ownerId,
		messageId: input.messageId,
	})
	if (!message) return null
	await authorizeEmailMessageInbox({ ...input, message })
	return message
}

/**
 * The inboxes a mailbox list may show this request: null when it holds
 * `email:read` for the whole org, otherwise only the inboxes it holds a grant
 * on. Lists pass the result to the mailbox as `inboxIds`.
 */
export async function loadReadableEmailInboxIds(ctx: {
	env: Env
	request: RequestContext | null
}): Promise<Array<string> | null> {
	const scope = await loadResourceListScope(ctx, 'email:read', 'email')
	return scope.kind === 'all' ? null : [...scope.ids]
}

/**
 * Inbox filter for a mailbox list or search. With `inboxId` the request must
 * hold `email:read` on that inbox; without it the list covers every inbox the
 * request can read.
 */
export async function resolveReadableEmailInboxFilter(input: {
	env: Env
	request: RequestContext | null
	ownerId: OwnerId
	inboxId: string | null
}): Promise<{ inboxId: string | null; inboxIds: Array<string> | null }> {
	if (input.inboxId) {
		await authorizeEmailMessageInbox({
			...input,
			message: { inboxId: input.inboxId },
			permission: 'email:read',
		})
		return { inboxId: input.inboxId, inboxIds: null }
	}
	return { inboxId: null, inboxIds: await loadReadableEmailInboxIds(input) }
}

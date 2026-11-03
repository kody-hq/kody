import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { mailboxDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import type { MailboxRpc } from './mailbox-do.ts'

export type MailboxEnv = {
	MAILBOX?: DurableObjectNamespace
}

export function mailboxNamespace(
	env: MailboxEnv,
): DurableObjectNamespace | null {
	return env.MAILBOX ?? null
}

/** Typed per-user Mailbox RPC stub; throws when `MAILBOX` is missing. */
export function mailboxRpc(input: {
	env: MailboxEnv
	userId: OwnerId
}): MailboxRpc {
	const namespace = mailboxNamespace(input.env)
	if (!namespace) {
		throw new Error('MAILBOX Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(mailboxDurableObjectName(input.userId)),
	) as unknown as MailboxRpc
}

export type { MailboxRpc }

import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { deleteSystemEmailMessageById } from '#worker/email/system-email-graph-store.ts'

export async function auditSystemEmailAccess(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action:
		| 'adminSystemEmailList'
		| 'adminSystemEmailGet'
		| 'adminSystemEmailDelete'
	result?: 'success' | 'failure'
	reason: string
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.action,
		result: input.result ?? 'success',
		email: input.actorEmail ?? undefined,
		ip: getRequestIp(input.request) ?? undefined,
		path: new URL(input.request.url).pathname,
		reason: input.reason,
	})
}

export async function deleteAdminSystemEmail({
	env,
	request,
	messageId: submittedMessageId,
}: {
	env: Env
	request: Request
	messageId: string
}) {
	const actor = await requireUserWithRole(request, env, 'admin')
	const messageId = submittedMessageId.trim()
	if (!messageId) {
		return adminOperationResult(
			{ ok: false, error: 'Message id is required.' },
			400,
		)
	}

	try {
		const deletion = await deleteSystemEmailMessageById({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			messageId,
		})
		if (!deletion.messageFound) {
			await auditSystemEmailAccess({
				env,
				request,
				actorEmail: actor.email,
				action: 'adminSystemEmailDelete',
				result: 'failure',
				reason: `System email message not found: ${messageId}`,
			})
			return adminOperationResult(
				{ ok: false, error: 'System email message not found.' },
				404,
			)
		}
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailDelete',
			reason: `target_message_id=${messageId}`,
		})
	} catch (error) {
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailDelete',
			result: 'failure',
			reason:
				error instanceof Error && error.message.trim().length > 0
					? error.message.slice(0, 240)
					: 'unknown_error',
		})
		throw error
	}

	return { ok: true as const, deletedMessageId: messageId }
}

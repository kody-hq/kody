import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { emailMessageTriageAuditReason } from '#worker/email/message-triage-audit.ts'
import {
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
	upsertEmailSenderRule,
} from '#worker/email/sender-rules.ts'
import { setEmailMessageClassification } from '#worker/email/service.ts'
import {
	deleteSystemEmailMessageById,
	getSystemEmailMessageById,
} from '#worker/email/system-email-graph-store.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	emailClassificationValues,
	manualEmailClassificationReason,
	type EmailClassification,
} from '#worker/email/types.ts'

export async function auditSystemEmailAccess(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action:
		| 'adminSystemEmailList'
		| 'adminSystemEmailGet'
		| 'adminSystemEmailDelete'
		| 'adminSystemEmailClassify'
		| 'adminSystemEmailSenderRuleSet'
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

export async function classifyAdminSystemEmail({
	env,
	request,
	messageId: submittedMessageId,
	classification,
	archived,
}: {
	env: Env
	request: Request
	messageId: string
	classification?: EmailClassification
	archived?: boolean
}) {
	const actor = await requireUserWithRole(request, env, 'admin')
	const messageId = submittedMessageId.trim()
	if (!messageId) {
		return adminOperationResult(
			{ ok: false, error: 'Message id is required.' },
			400,
		)
	}
	if (classification === undefined && archived === undefined) {
		return adminOperationResult(
			{ ok: false, error: 'Provide classification, archived, or both.' },
			400,
		)
	}
	if (
		classification !== undefined &&
		!emailClassificationValues.includes(classification)
	) {
		return adminOperationResult(
			{
				ok: false,
				error: 'Classification must be accepted, quarantined, or spam.',
			},
			400,
		)
	}
	const change = { messageId, classification, archived }

	let updated: boolean
	try {
		updated = await setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			messageId,
			...(classification === undefined
				? {}
				: {
						classification,
						classificationReason:
							manualEmailClassificationReason(classification),
					}),
			archived,
		})
	} catch (error) {
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailClassify',
			result: 'failure',
			reason:
				error instanceof Error && error.message.trim().length > 0
					? error.message.slice(0, 240)
					: 'unknown_error',
		})
		throw error
	}
	await auditSystemEmailAccess({
		env,
		request,
		actorEmail: actor.email,
		action: 'adminSystemEmailClassify',
		result: updated ? 'success' : 'failure',
		reason: emailMessageTriageAuditReason(
			change,
			updated ? undefined : 'not_found',
		),
	})
	if (!updated) {
		return adminOperationResult(
			{ ok: false, error: 'System email message not found.' },
			404,
		)
	}

	return {
		ok: true as const,
		messageId,
		...(classification === undefined ? {} : { classification }),
		...(archived === undefined ? {} : { archived }),
	}
}

/**
 * Explicit "block this sender" follow-up offered after marking spam. The rule
 * address comes from the stored message, never from the client.
 */
export async function blockAdminSystemEmailSender({
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
	const message = await getSystemEmailMessageById({
		db: env.APP_DB,
		messageId,
	})
	const address =
		message?.direction === 'inbound' && message.fromAddress
			? normalizeEmailAddress(message.fromAddress)
			: null
	if (!address) {
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailSenderRuleSet',
			result: 'failure',
			reason: `target_message_id=${messageId};sender_unavailable`,
		})
		return adminOperationResult(
			{
				ok: false,
				error: message
					? 'This message has no sender address to block.'
					: 'System email message not found.',
			},
			message ? 400 : 404,
		)
	}
	try {
		const rule = await upsertEmailSenderRule({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			kind: 'address',
			value: address,
			effect: 'block',
			note: `Blocked after marking message ${messageId} as spam.`,
		})
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailSenderRuleSet',
			reason: `rule_id=${rule.id};kind=${rule.kind};effect=${rule.effect};target_message_id=${messageId}`,
		})
		return {
			ok: true as const,
			messageId,
			rule: { id: rule.id, kind: rule.kind, value: rule.value },
		}
	} catch (error) {
		await auditSystemEmailAccess({
			env,
			request,
			actorEmail: actor.email,
			action: 'adminSystemEmailSenderRuleSet',
			result: 'failure',
			reason:
				error instanceof Error && error.message.trim().length > 0
					? error.message.slice(0, 240)
					: 'unknown_error',
		})
		if (
			error instanceof EmailSenderRuleValidationError ||
			error instanceof EmailSenderRuleLimitError
		) {
			return adminOperationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}

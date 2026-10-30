import { clearOutboundDeliveryPause } from '#worker/email/outbound-consecutive-failures.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import {
	deleteEmailMessage,
	setEmailMessageClassification,
} from '#worker/email/service.ts'
import {
	emailClassificationValues,
	manualEmailClassificationReason,
	type EmailClassification,
} from '#worker/email/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { authorizeEmailMessageChange } from '#worker/email/authorize-email-message.ts'
import { auditUserEmailMessageTriage } from '#worker/email/message-triage-audit.ts'
import { getOwnerEmailMessageById } from '#worker/email/owner-email-reader.ts'
import {
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
	upsertEmailSenderRule,
} from '#worker/email/sender-rules.ts'

type EmailMutationContext = {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	/** Present on website mutations; used only for the audit IP. */
	request?: Request
	messageId: string
}
export async function deleteAccountEmailMessage({
	env,
	user,
	messageId,
}: EmailMutationContext) {
	await authorize({ env, request: user.request }, 'email:delete')
	if (!messageId.trim())
		return operationResult({ ok: false, error: 'Message id is required.' }, 400)
	const ownerId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const message = await authorizeEmailMessageChange({
		env,
		request: user.request,
		ownerId,
		messageId,
		permission: 'email:delete',
	})
	const deleted = message
		? await deleteEmailMessage({
				env,
				db: env.APP_DB,
				userId: ownerId,
				messageId,
			})
		: false
	if (!deleted) {
		return operationResult({ ok: false, error: 'Message not found.' }, 404)
	}

	return operationResult({ ok: true as const, messageId })
}
export async function classifyAccountEmailMessage({
	env,
	user,
	request,
	messageId,
	classification,
	archived,
}: EmailMutationContext & {
	classification?: EmailClassification
	archived?: boolean
}) {
	await authorize({ env, request: user.request }, 'email:write')
	if (!messageId.trim())
		return operationResult({ ok: false, error: 'Message id is required.' }, 400)
	if (classification === undefined && archived === undefined)
		return operationResult(
			{ ok: false, error: 'Provide classification, archived, or both.' },
			400,
		)
	if (
		classification !== undefined &&
		!emailClassificationValues.includes(classification)
	)
		return operationResult(
			{
				ok: false,
				error: 'Classification must be accepted, quarantined, or spam.',
			},
			400,
		)
	const ownerId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	if (ownerId === systemEmailOwnerId)
		return operationResult(
			{ ok: false, error: 'System inbox messages are triaged by admins.' },
			403,
		)
	const message = await authorizeEmailMessageChange({
		env,
		request: user.request,
		ownerId,
		messageId,
		permission: 'email:write',
	})
	const updated = message
		? await setEmailMessageClassification({
				env,
				db: env.APP_DB,
				userId: ownerId,
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
		: false
	await auditUserEmailMessageTriage({
		env,
		actorEmail: user.email,
		path: '/account/email',
		ip: request ? getRequestIp(request) : null,
		result: updated ? 'success' : 'failure',
		change: { messageId, classification, archived },
		outcome: updated ? undefined : 'not_found',
	})
	if (!updated) {
		return operationResult(
			{
				ok: false,
				error: 'Message not found or is not an inbound message.',
			},
			404,
		)
	}

	return operationResult({
		ok: true as const,
		messageId,
		...(classification === undefined ? {} : { classification }),
		...(archived === undefined ? {} : { archived }),
	})
}

/**
 * Explicit "block this sender" follow-up offered after marking spam. The rule
 * address comes from the stored message, never from the client.
 */
export async function blockAccountEmailSender({
	env,
	user,
	request,
	messageId,
}: EmailMutationContext) {
	await authorize({ env, request: user.request }, 'email:write')
	if (!messageId.trim())
		return operationResult({ ok: false, error: 'Message id is required.' }, 400)
	const ownerId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	if (ownerId === systemEmailOwnerId)
		return operationResult(
			{ ok: false, error: 'System inbox sender rules are managed by admins.' },
			403,
		)
	const message = await getOwnerEmailMessageById({
		env,
		ownerId,
		messageId,
	})
	const address =
		message?.direction === 'inbound' && message.fromAddress
			? normalizeEmailAddress(message.fromAddress)
			: null
	if (!address) {
		return operationResult(
			{
				ok: false,
				error: message
					? 'This message has no sender address to block.'
					: 'Message not found.',
			},
			message ? 400 : 404,
		)
	}
	try {
		const rule = await upsertEmailSenderRule({
			db: env.APP_DB,
			userId: ownerId,
			kind: 'address',
			value: address,
			effect: 'block',
			note: `Blocked after marking message ${messageId} as spam.`,
		})
		await logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'emailSenderRuleSet',
			result: 'success',
			email: user.email,
			ip: request ? (getRequestIp(request) ?? undefined) : undefined,
			path: '/account/email',
			reason: `rule_id=${rule.id};kind=${rule.kind};effect=${rule.effect};target_message_id=${messageId}`,
		})
		return operationResult({
			ok: true as const,
			messageId,
			rule: { id: rule.id, kind: rule.kind, value: rule.value },
		})
	} catch (error) {
		if (
			error instanceof EmailSenderRuleValidationError ||
			error instanceof EmailSenderRuleLimitError
		) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}

export async function resumeAccountOutboundDelivery({
	env,
	user,
}: Omit<EmailMutationContext, 'messageId'>) {
	await authorize({ env, request: user.request }, 'email:write')
	await clearOutboundDeliveryPause({
		db: env.APP_DB,
		ownerId: ownerIdFromCaller({ request: user.request, user: user.mcpUser }),
	})
	return operationResult({ ok: true as const })
}

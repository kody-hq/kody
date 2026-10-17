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
	type EmailClassification,
} from '#worker/email/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

type EmailMutationContext = {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	messageId: string
}
export async function deleteAccountEmailMessage({
	env,
	user,
	messageId,
}: EmailMutationContext) {
	await authorize({ env, request: user.request }, 'email:read')
	if (!messageId.trim())
		return operationResult({ ok: false, error: 'Message id is required.' }, 400)
	const deleted = await deleteEmailMessage({
		env,
		db: env.APP_DB,
		userId: ownerIdFromCaller({
			request: user.request,
			user: user.mcpUser,
		}),
		messageId,
	})
	if (!deleted) {
		return operationResult({ ok: false, error: 'Message not found.' }, 404)
	}

	return operationResult({ ok: true as const, messageId })
}
export async function classifyAccountEmailMessage({
	env,
	user,
	messageId,
	classification,
}: EmailMutationContext & { classification: EmailClassification }) {
	await authorize({ env, request: user.request }, 'email:read')
	if (!messageId.trim())
		return operationResult({ ok: false, error: 'Message id is required.' }, 400)
	if (!emailClassificationValues.includes(classification))
		return operationResult(
			{ ok: false, error: 'Classification must be accepted or quarantined.' },
			400,
		)
	const updated = await setEmailMessageClassification({
		env,
		db: env.APP_DB,
		userId: ownerIdFromCaller({
			request: user.request,
			user: user.mcpUser,
		}),
		messageId,
		classification,
		classificationReason:
			classification === 'quarantined' ? 'Reclassified by user.' : null,
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

	return operationResult({ ok: true as const, messageId, classification })
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

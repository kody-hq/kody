import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	loadAdminPlatformFeedbackData,
	readAdminPlatformFeedbackId,
} from '#app/admin-platform-feedback-data.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'

const maxAuditFeedbackIdLength = 200

export function readRequestedFeedbackId(request: Request) {
	return readAdminPlatformFeedbackId(
		new URL(request.url).searchParams.get('feedbackId'),
	)
}

function sanitizeFeedbackIdForAudit(feedbackId: string) {
	return feedbackId
		.replace(/[^A-Za-z0-9._:-]/g, '?')
		.slice(0, maxAuditFeedbackIdLength)
}

export async function auditPlatformFeedbackRead(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action: 'adminPlatformFeedbackList' | 'adminPlatformFeedbackGet'
	feedbackId?: string | null
	notFound?: boolean
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.action,
		result: 'success',
		email: input.actorEmail ?? undefined,
		ip: getRequestIp(input.request) ?? undefined,
		path: new URL(input.request.url).pathname,
		reason: input.feedbackId
			? `feedback_id=${sanitizeFeedbackIdForAudit(input.feedbackId)}${
					input.notFound ? ';not_found' : ''
				}`
			: 'platform_feedback_list',
	})
}

export async function readAdminPlatformFeedback({
	env,
	request,
}: {
	env: Env
	request: Request
}) {
	const actor = await requireUserWithRole(request, env, 'admin')
	const payload = await loadAdminPlatformFeedbackData(env, request.url)
	const feedbackId = readRequestedFeedbackId(request)
	await auditPlatformFeedbackRead({
		env,
		request,
		actorEmail: actor.email,
		action: feedbackId
			? 'adminPlatformFeedbackGet'
			: 'adminPlatformFeedbackList',
		feedbackId,
		notFound: feedbackId !== null && payload.selectedFeedback === null,
	})
	return payload
}

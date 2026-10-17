import { type TipsUnsubscribeResult } from '#universal/token-outcomes.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	optOutTipsEmails,
	verifyTipsUnsubscribeToken,
} from '#worker/usage/tips-unsubscribe.ts'

function getUnsubscribeError(reason: 'missing_token' | 'invalid_token') {
	switch (reason) {
		case 'missing_token':
			return 'Unsubscribe token is required.'
		case 'invalid_token':
			return 'Unsubscribe link is invalid.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export async function executeUnsubscribeTips({
	request,
	env,
	token,
}: {
	request: Request
	env: Env
	token: string | null
}): Promise<TipsUnsubscribeResult> {
	const claims = await verifyTipsUnsubscribeToken({
		env,
		token,
	})
	const requestIp = getRequestIp(request) ?? undefined

	if (!claims) {
		const reason = token?.trim() ? 'invalid_token' : 'missing_token'
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'tips_unsubscribe',
			result: 'failure',
			ip: requestIp,
			path: '/unsubscribe/tips',
			reason,
		})
		return {
			title: 'Unsubscribe from tips',
			status: 400,
			ok: false,
			error: getUnsubscribeError(reason),
		}
	}

	const result = await optOutTipsEmails({
		db: env.APP_DB,
		userId: claims.userId,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'tips_unsubscribe',
		result: result.optedOut ? 'success' : 'failure',
		ip: requestIp,
		path: '/unsubscribe/tips',
		reason: result.alreadyOptedOut
			? 'already_opted_out'
			: result.optedOut
				? 'opted_out'
				: 'user_not_found',
	})

	if (!result.optedOut) {
		return {
			title: 'Unsubscribe from tips',
			status: 400,
			ok: false,
			error: 'Unsubscribe link is invalid.',
		}
	}

	const message = result.alreadyOptedOut
		? 'You were already unsubscribed from Kody tips.'
		: 'You are unsubscribed from Kody tips. Transactional mail such as verification, billing, and error-rate alerts is unchanged.'
	return {
		title: 'Unsubscribed from tips',
		ok: true,
		alreadyOptedOut: result.alreadyOptedOut,
		message,
	}
}

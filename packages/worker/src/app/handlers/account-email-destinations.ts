import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	createEmailDestinationVerification,
	emailDestinationRateLimitConfig,
	resendEmailDestinationVerification,
} from '#worker/email/destination-verification.ts'
import {
	EmailDestinationError,
	deleteEmailNotificationDestination,
	changeDefaultEmailNotificationDestination,
} from '#worker/email/destinations.ts'

export { emailDestinationRateLimitConfig }

type DestinationContext = {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
type DestinationPayload = { ok: true; message: string }
async function runDestinationOperation(
	{ request, env, user }: DestinationContext,
	action: 'add' | 'resend' | 'setDefault' | 'remove',
	run: () => Promise<DestinationPayload>,
) {
	const requestIp = getRequestIp(request) ?? undefined

	if (!user.emailVerified) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: 'email_unverified',
		})
		return operationResult(
			{
				ok: false,
				error: 'Verify your account email before managing destinations.',
			},
			403,
		)
	}

	try {
		return operationResult(await run())
	} catch (error) {
		if (error instanceof EmailDestinationError) {
			if (error.code === 'rate_limited') {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
					result: 'rate_limited',
					email: user.email,
					ip: requestIp,
					path: '/account/email',
					reason: action,
				})
				return operationResult(
					{ ok: false, error: error.message },
					{
						status: 429,
						headers: {
							'Retry-After': String(
								emailDestinationRateLimitConfig.windowSeconds,
							),
						},
					},
				)
			}
			const status =
				error.code === 'not_found' ? 404 : error.code === 'at_cap' ? 409 : 400
			return operationResult({ ok: false, error: error.message }, status)
		}
		if (
			error instanceof Error &&
			(error.message === 'Email destination was not found.' ||
				error.message === 'That address is already verified.')
		) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		console.error('Failed to update email destinations:', error)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: 'send_failed',
		})
		return operationResult(
			{
				ok: false,
				error: 'Unable to update email destinations. Please try again later.',
			},
			502,
		)
	}
}

export async function addAccountEmailDestination(
	input: DestinationContext & { email: string },
) {
	const { request, env, user } = input
	const email = input.email.trim()
	const requestIp = getRequestIp(request) ?? undefined
	return runDestinationOperation(input, 'add', async () => {
		const result = await createEmailDestinationVerification({
			env,
			userId: user.userId,
			email,
			requestUrl: new URL(request.url),
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: `add=${result.destination.email}`,
		})
		return {
			ok: true,
			message: result.created
				? 'Verification email sent. Open the link to start using this address.'
				: 'Verification email sent again. Open the latest link to start using this address.',
		}
	})
}

export async function resendAccountEmailDestination(
	input: DestinationContext & { destinationId: string },
) {
	const { request, env, user } = input
	const destinationId = input.destinationId.trim()
	const requestIp = getRequestIp(request) ?? undefined
	return runDestinationOperation(input, 'resend', async () => {
		const destination = await resendEmailDestinationVerification({
			env,
			userId: user.userId,
			destinationId,
			requestUrl: new URL(request.url),
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: `resend=${destination.email}`,
		})
		return {
			ok: true,
			message: 'Verification email sent again.',
		}
	})
}

export async function setDefaultAccountEmailDestination(
	input: DestinationContext & { destinationId: string },
) {
	const { request, env, user } = input
	const destinationId = input.destinationId.trim()
	const requestIp = getRequestIp(request) ?? undefined
	return runDestinationOperation(input, 'setDefault', async () => {
		await changeDefaultEmailNotificationDestination({
			db: env.APP_DB,
			dbUserId: user.userId,
			destinationId,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: `set_default=${destinationId}`,
		})
		return {
			ok: true,
			message: 'Default email destination updated.',
		}
	})
}

export async function removeAccountEmailDestination(
	input: DestinationContext & { destinationId: string },
) {
	const { request, env, user } = input
	const destinationId = input.destinationId.trim()
	const requestIp = getRequestIp(request) ?? undefined
	return runDestinationOperation(input, 'remove', async () => {
		await deleteEmailNotificationDestination({
			db: env.APP_DB,
			dbUserId: user.userId,
			destinationId,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_destination',
			result: 'success',
			email: user.email,
			ip: requestIp,
			path: '/account/email',
			reason: `remove=${destinationId}`,
		})
		return {
			ok: true,
			message: 'Email destination removed.',
		}
	})
}

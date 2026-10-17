import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, optional, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	createEmailDestinationVerification,
	emailDestinationRateLimitConfig,
	resendEmailDestinationVerification,
} from '#worker/email/destination-verification.ts'
import {
	EmailDestinationError,
	buildEmailDestinationsLoaderData,
	listEmailNotificationDestinations,
	removeEmailNotificationDestination,
	setDefaultEmailNotificationDestination,
	type EmailDestinationErrorCode,
} from '#worker/email/destinations.ts'
import { type routes } from '#universal/routes.ts'

export { emailDestinationRateLimitConfig }

function destinationVerificationHttpStatus(
	code: EmailDestinationErrorCode,
): number {
	switch (code) {
		case 'rate_limited':
		case 'user_daily_cap':
		case 'recipient_daily_cap':
			return 429
		case 'account_too_new':
			return 403
		case 'not_found':
			return 404
		case 'at_cap':
			return 409
		case 'invalid_email':
		case 'identity_email':
		case 'already_added':
		case 'not_verified':
		case 'cannot_remove_identity':
			return 400
		default: {
			const exhaustive: never = code
			return exhaustive
		}
	}
}

const destinationMutationSchema = object({
	action: enum_(['add', 'resend', 'setDefault', 'remove'] as const),
	email: optional(string()),
	id: optional(string()),
})

const destinationListPayload = buildEmailDestinationsLoaderData

export function createAccountEmailDestinationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const destinations = await listEmailNotificationDestinations({
					db: env.APP_DB,
					dbUserId: user.userId,
					accountEmail: user.email,
					accountEmailVerified: user.emailVerified,
				})
				return jsonResponse(destinationListPayload(destinations))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse({ ok: false, error: 'Invalid JSON payload.' }, 400)
			}

			const parsed = parseSafe(destinationMutationSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const action = parsed.value.action
			const email = parsed.value.email?.trim() ?? ''
			const destinationId = parsed.value.id?.trim() ?? ''
			const requestIp = getRequestIp(request) ?? undefined

			if (!user.emailVerified) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_unverified',
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Verify your account email before managing destinations.',
					},
					403,
				)
			}

			try {
				if (action === 'add' || action === 'resend') {
					if (action === 'add') {
						const result = await createEmailDestinationVerification({
							env,
							userId: user.userId,
							email,
							requestUrl: url,
						})
						const destinations = await listEmailNotificationDestinations({
							db: env.APP_DB,
							dbUserId: user.userId,
							accountEmail: user.email,
							accountEmailVerified: user.emailVerified,
						})
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'email_destination',
							result: 'success',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason: `add=${result.destination.email}`,
						})
						return jsonResponse({
							...destinationListPayload(destinations),
							message: result.created
								? 'Verification email sent. Open the link to start using this address.'
								: 'Verification email sent again. Open the latest link to start using this address.',
						})
					}

					const destination = await resendEmailDestinationVerification({
						env,
						userId: user.userId,
						destinationId,
						requestUrl: url,
					})
					const destinations = await listEmailNotificationDestinations({
						db: env.APP_DB,
						dbUserId: user.userId,
						accountEmail: user.email,
						accountEmailVerified: user.emailVerified,
					})
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'account',
						action: 'email_destination',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: `resend=${destination.email}`,
					})
					return jsonResponse({
						...destinationListPayload(destinations),
						message: 'Verification email sent again.',
					})
				}

				if (action === 'setDefault') {
					const destinations = await setDefaultEmailNotificationDestination({
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
						path: url.pathname,
						reason: `set_default=${destinationId}`,
					})
					return jsonResponse({
						...destinationListPayload(destinations),
						message: 'Default email destination updated.',
					})
				}

				const destinations = await removeEmailNotificationDestination({
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
					path: url.pathname,
					reason: `remove=${destinationId}`,
				})
				return jsonResponse({
					...destinationListPayload(destinations),
					message: 'Email destination removed.',
				})
			} catch (error) {
				if (error instanceof EmailDestinationError) {
					const status = destinationVerificationHttpStatus(error.code)
					if (
						error.code === 'rate_limited' ||
						error.code === 'user_daily_cap' ||
						error.code === 'recipient_daily_cap' ||
						error.code === 'account_too_new'
					) {
						void logAuditEvent({
							db: auditDatabaseFromEnv(env),
							category: 'account',
							action: 'email_destination',
							result:
								error.code === 'account_too_new' ? 'failure' : 'rate_limited',
							email: user.email,
							ip: requestIp,
							path: url.pathname,
							reason:
								error.code === 'rate_limited'
									? action
									: `${action}:${error.code}`,
						})
					}
					const headers =
						error.retryAfterSeconds == null
							? undefined
							: { 'Retry-After': String(error.retryAfterSeconds) }
					return jsonResponse(
						{ ok: false, error: error.message },
						headers ? { status, headers } : status,
					)
				}
				if (
					error instanceof Error &&
					(error.message === 'Email destination was not found.' ||
						error.message === 'That address is already verified.')
				) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				console.error('Failed to update email destinations:', error)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_destination',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'send_failed',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Unable to update email destinations. Please try again later.',
					},
					502,
				)
			}
		},
	} satisfies Action<typeof routes.accountEmailDestinationsApiPost>
}

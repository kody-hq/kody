import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	createAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { verifyEmailChangeToken } from '#app/email-change.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

function getVerifyEmailChangeError(result: {
	reason:
		| 'missing_token'
		| 'invalid_token'
		| 'expired_token'
		| 'email_conflict'
		| 'email_rejected'
	error?: string
}) {
	switch (result.reason) {
		case 'missing_token':
			return 'Verification token is required.'
		case 'invalid_token':
			return 'Email change link is invalid.'
		case 'expired_token':
			return 'Email change link has expired.'
		case 'email_conflict':
			return 'That email address is already registered.'
		case 'email_rejected':
			return (
				result.error ??
				'That email address cannot be used. Use a different address.'
			)
		default: {
			const unreachable: never = result.reason
			return unreachable
		}
	}
}

export function createVerifyEmailChangeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			setAuthSessionSecret(env.COOKIE_SECRET)
			const result = await verifyEmailChangeToken({
				db: env.APP_DB,
				token: url.searchParams.get('token'),
			})
			const requestIp = getRequestIp(request) ?? undefined

			if (!result.ok) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_verify',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason: result.reason,
				})
				return renderAppPage({
					request,
					env,
					title: 'Verify email change',
					status: 400,
					loaderData: {
						emailVerification: {
							ok: false,
							error: getVerifyEmailChangeError(result),
						},
					},
				})
			}

			const { session } = await readAuthSessionResult(request)
			const setCookie =
				session?.stableUserId === result.stableUserId
					? await createAuthCookie(
							{
								stableUserId: session.stableUserId,
								email: result.newEmail,
								rememberMe: session.rememberMe,
							},
							isSecureRequest(request),
						)
					: null

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'email_change_verify',
				result: 'success',
				email: result.newEmail,
				ip: requestIp,
				path: url.pathname,
				reason: `old_email=${result.oldEmail}`,
			})
			return renderAppPage({
				request,
				env,
				title: 'Email changed',
				extraSetCookies: setCookie ? [setCookie] : undefined,
				loaderData: {
					emailVerification: {
						ok: true,
						kind: 'email_change',
						message:
							'Your account email has been changed and verified. The previous address stays tied to this account until you release it from Account settings → Former addresses.',
					},
				},
			})
		},
	} satisfies Action<typeof routes.verifyEmailChange>
}

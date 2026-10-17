import { setExperimentsOptIn } from '#app/account-experiments-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'

export async function saveExperimentsPreference({
	request,
	env,
	user,
	experimentsOptIn,
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	experimentsOptIn: boolean
}) {
	await setExperimentsOptIn(env.APP_DB, {
		userId: user.userId,
		enabled: experimentsOptIn,
	})

	const requestIp = getRequestIp(request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: experimentsOptIn ? 'experiments_opt_in' : 'experiments_opt_out',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: new URL(request.url).pathname,
		reason: `experiments_opt_in=${experimentsOptIn}`,
	})

	return operationResult({ ok: true as const, experimentsOptIn })
}

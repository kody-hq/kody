import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { setSelfServeExperimentForUser } from '#worker/feature-flags/self-serve-experiments.ts'
import { type SelfServeExperimentId } from '#universal/feature-flags/experiments.ts'

export async function setWebsiteExperiment(input: {
	env: Env
	request: Request
	user: Pick<AuthenticatedAppUser, 'userId' | 'email'>
	experiment: SelfServeExperimentId
	enabled: boolean
}) {
	const { env, request, user, experiment, enabled } = input
	const definition = await setSelfServeExperimentForUser(env.APP_DB, {
		userId: user.userId,
		id: experiment,
		enabled,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: enabled ? 'feature_flag_self_opt_in' : 'feature_flag_self_opt_out',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: '/account/experiments',
		reason: `key=${definition.flagKey}`,
	})
	return { ok: true as const, enabled }
}

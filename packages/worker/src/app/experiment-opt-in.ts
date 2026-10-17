import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { setFeatureFlagUserOverride } from '#worker/feature-flags/service.ts'
import {
	mcpSkillsExtensionFlagKey,
	mcpEventsExtensionFlagKey,
} from '#universal/feature-flags/registry.ts'

export async function optIntoWebsiteExperiment(input: {
	env: Env
	request: Request
	user: Pick<AuthenticatedAppUser, 'userId' | 'email'>
	experiment: 'package-skills' | 'mcp-events'
}) {
	const { env, request, user, experiment } = input
	const key =
		experiment === 'package-skills'
			? mcpSkillsExtensionFlagKey
			: mcpEventsExtensionFlagKey
	await setFeatureFlagUserOverride(env.APP_DB, {
		key,
		userId: user.userId,
		enabled: true,
		updatedBy: user.userId,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'feature_flag_self_opt_in',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: `/docs/${experiment}`,
		reason: `key=${key}`,
	})
	return { ok: true as const }
}

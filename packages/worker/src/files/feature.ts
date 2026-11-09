import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { getFeatureFlagEvaluationsForUser } from '#worker/feature-flags/service.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export function filesWorkspaceOverride(env: Env): boolean | undefined {
	if (env.FILES_COLLABORATION_ENABLED === 'false') return false
	if (
		env.WRANGLER_IS_LOCAL_DEV === 'true' &&
		env.FILES_COLLABORATION_ENABLED === 'true'
	)
		return true
}

/** The environment switch is a local-dev override or a production kill switch. */
export async function fileCollaborationEnabled(
	env: Env,
	request: RequestContext,
) {
	if (!request.actor) return false
	const override = filesWorkspaceOverride(env)
	if (override !== undefined) return override
	const user = await env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(request.actor.userId)
		.first<{ id: number }>()
	if (!user) return false
	try {
		return (
			await getFeatureFlagEvaluationsForUser(env.APP_DB, user.id, {
				orgId: request.org.id,
			})
		)['files-workspace'].enabled
	} catch {
		return false
	}
}

/** Root file visibility is a workspace policy, not a change to unrelated authorization. */
export async function fileEffectivePermissions(
	env: Env,
	request: RequestContext,
) {
	const { computeEffectivePermissions } =
		await import('#worker/authorization/authorize.ts')
	const effective = await computeEffectivePermissions({ env, request })
	return request.membership?.role === 'member' &&
		(await fileCollaborationEnabled(env, request))
		? {
				...effective,
				permissions: new Set([...effective.permissions, 'file:read' as const]),
			}
		: effective
}

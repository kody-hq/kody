import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { loadPackageSessionInsights } from '#worker/session-analytics/insights.ts'

/**
 * Publisher analytics for one package: combined totals from other
 * organizations that turned on session analytics, for people who can read
 * the package in the organization that publishes it.
 */
export async function readPackageSessionInsightsData(
	request: Request,
	params: { username: string; kodyId: string },
	env: Env,
) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return { status: 401 as const }
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		params.username,
	)
	if (!binding) return { status: 404 as const }
	const savedPackage = await resolveSavedPackage({
		db: env.APP_DB,
		userId: binding.org.id,
		packageIdOrKodyId: params.kodyId.trim(),
	})
	if (!savedPackage) return { status: 404 as const }
	const access = await computeEffectivePermissions({
		env,
		request: deriveRequestContext({
			user: user.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	})
	if (
		!checkPermission(access, 'package:read', packageResource(savedPackage))
			.allowed
	) {
		return { status: 404 as const }
	}
	return {
		status: 200 as const,
		data: await loadPackageSessionInsights(env.APP_DB, {
			packageId: savedPackage.id,
			now: new Date(),
		}),
	}
}

import { operationResult } from '../operation-result.ts'
import type { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { loadOrgSessionAnalyticsState } from '#worker/session-analytics/consent.ts'
import {
	deleteSessionInsights,
	loadSessionInsights,
	type SessionInsightsEntryKey,
} from '#worker/session-analytics/insights.ts'
import type { OrgSessionInsightsLoaderData } from '#universal/loader-data.ts'
import type { SessionInsightsScope } from '#universal/session-analytics.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

/**
 * The insights Kody staff see, limited to this org: the member's own data,
 * and the whole org for people who can change org settings.
 */
export async function loadOrgSessionInsightsData(input: {
	env: Env
	user: AppUser
	org: ManagedOrg
}): Promise<OrgSessionInsightsLoaderData> {
	const db = input.env.APP_DB
	const now = new Date()
	const canSeeOrg = await orgHasPermission(input.env, input.user, 'org:write')
	const [state, mine, org] = await Promise.all([
		loadOrgSessionAnalyticsState(db, input.org.id),
		loadSessionInsights(db, {
			owner: { orgId: input.org.id, userId: input.user.mcpUser.userId },
			now,
		}),
		canSeeOrg
			? loadSessionInsights(db, { owner: { orgId: input.org.id }, now })
			: null,
	])
	return {
		org: {
			slug: input.org.slug,
			displayName: input.org.displayName ?? input.org.slug,
			personal: input.org.personal,
		},
		state,
		mine,
		organization: org,
	}
}

export async function deleteOrganizationSessionInsights(input: {
	env: Env
	request: Request
	user: AppUser
	orgSlug?: string
	scope: SessionInsightsScope
	entry?: SessionInsightsEntryKey
}) {
	const { env, request, user } = input
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		orgSlug: input.orgSlug,
		permission: input.scope === 'org' ? 'org:write' : 'org:read',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	const deleted = await deleteSessionInsights(env.APP_DB, {
		owner:
			input.scope === 'org'
				? { orgId: access.org.id }
				: { orgId: access.org.id, userId: user.mcpUser.userId },
		...(input.entry ? { entry: input.entry } : {}),
	})
	return operationResult({ ok: true, deletedRows: deleted.deletedRows })
}

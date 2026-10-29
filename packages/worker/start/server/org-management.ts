import { createServerFn } from '@tanstack/react-start'
import { PermissionDeniedError } from '#universal/permission-denied.ts'
import { notFound } from '@tanstack/react-router'
import { z } from 'zod'

async function orgContext(slug: string, section: string) {
	const [
		{ loadPersonalCollection },
		{ loadOrgBindingForSlug },
		{ deriveRequestContext },
	] = await Promise.all([
		import('./collection-context.ts'),
		import('#worker/orgs/repo.ts'),
		import('#worker/request-context/request-context.ts'),
	])
	const {
		bindings,
		request,
		user: authenticated,
	} = await loadPersonalCollection(`/@${encodeURIComponent(slug)}/-/${section}`)
	const binding = await loadOrgBindingForSlug(
		bindings.APP_DB,
		authenticated.mcpUser.userId,
		slug,
	)
	if (!binding) throw notFound()
	const user = {
		...authenticated,
		request: deriveRequestContext({
			user: authenticated.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	}
	return { env: bindings, request, user, binding, orgSlug: slug }
}
const slugInput = z.object({ slug: z.string().regex(/^[a-zA-Z0-9_-]+$/) })

export const loadOrgMembers = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'members')
		const [{ resolveOrgManagementAccess }, { loadOrgMembersData }] =
			await Promise.all([
				import('../../src/app/org-management-access.ts'),
				import('../../src/app/handlers/org-members.ts'),
			])
		const access = await resolveOrgManagementAccess({
			...input,
			permission: 'member:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(403)
			throw new PermissionDeniedError(access.error)
		}

		return loadOrgMembersData({ ...input, org: access.org })
	})

export const loadOrgSettings = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'settings')
		const [{ resolveOrgManagementAccess }, { loadOrgSettingsData }] =
			await Promise.all([
				import('../../src/app/org-management-access.ts'),
				import('../../src/app/handlers/org-settings.ts'),
			])
		const access = await resolveOrgManagementAccess({
			...input,
			permission: 'org:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(403)
			throw new PermissionDeniedError(access.error)
		}

		return loadOrgSettingsData({ ...input, org: access.org })
	})

export const loadOrgTeams = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'teams')
		const [{ resolveOrgManagementAccess }, { loadOrgTeamsData }] =
			await Promise.all([
				import('../../src/app/org-management-access.ts'),
				import('../../src/app/handlers/org-teams.ts'),
			])
		const access = await resolveOrgManagementAccess({
			...input,
			permission: 'team:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(403)
			throw new PermissionDeniedError(access.error)
		}

		return loadOrgTeamsData({ ...input, org: access.org })
	})

export const loadOrgGrants = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'grants')
		const [{ resolveOrgManagementAccess }, { loadOrgGrantsData }] =
			await Promise.all([
				import('../../src/app/org-management-access.ts'),
				import('../../src/app/handlers/org-grants.ts'),
			])
		const access = await resolveOrgManagementAccess({
			...input,
			permission: 'member:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(403)
			throw new PermissionDeniedError(access.error)
		}

		return loadOrgGrantsData({ ...input, org: access.org })
	})

export const loadOrgCollaborators = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'collaborators')
		const [{ resolveOrgManagementAccess }, { loadOrgCollaboratorsData }] =
			await Promise.all([
				import('../../src/app/org-management-access.ts'),
				import('../../src/app/handlers/org-collaborators.ts'),
			])
		const access = await resolveOrgManagementAccess({
			...input,
			permission: 'member:read',
		})
		if (!access.ok) {
			if (access.status === 404) throw notFound()
			const { setResponseStatus } = await import('@tanstack/react-start/server')
			setResponseStatus(403)
			throw new PermissionDeniedError(access.error)
		}

		return loadOrgCollaboratorsData({ ...input, org: access.org })
	})

export const loadOrgInvite = createServerFn({ method: 'GET' })
	.validator(z.object({ token: z.string().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getEnv },
			{ getRequest, setResponseHeader },
			{ loadJoinPageData },
			{ setAuthSessionSecret },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/handlers/org-invite-join.ts'),
			import('../../src/app/auth-session.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'no-store')
		return loadJoinPageData({
			env: bindings,
			request: getRequest(),
			token: data.token,
		})
	})

export const loadOrgOverview = createServerFn({ method: 'GET' })
	.validator(slugInput)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'overview')
		const { personalOrgIdForPerson } =
			await import('../../src/orgs/personal-org-id.ts')
		const resolution = input.binding
		const slug = resolution.org.slug ?? data.slug
		if (resolution.role === null) throw notFound()

		const [
			{ loadProfileData },
			{ loadOrgRepositoriesData },
			{ loadAccountActivityData },
			{ loadAccountJobsData },
			{ loadWorkspaceRunCharts },
			{ loadOrgUsagePageResult },
			{ overviewExecutionTotals },
		] = await Promise.all([
			import('../../src/app/profile-data.ts'),
			import('../../src/app/org-repositories-data.ts'),
			import('../../src/app/account-activity-data.ts'),
			import('../../src/app/account-jobs-data.ts'),
			import('../../src/run-records/service.ts'),
			import('../../src/app/handlers/org-usage.ts'),
			import('../../universal/workspace-charts.ts'),
		])
		const { loadSkillMetrics } = await import('#app/skill-metrics.ts')
		const { createMcpCallerContext } = await import('#mcp/context.ts')
		const [skillMetrics, repositories, activity, jobs, charts, usage] =
			await Promise.all([
				loadSkillMetrics({
					env: input.env,
					callerContext: {
						...createMcpCallerContext({
							baseUrl: new URL(input.request.url).origin,
							user: input.user.mcpUser,
							source: { kind: 'session' },
						}),
						request: input.user.request,
					},
					failOnError: false,
				}),
				resolution.org.id === personalOrgIdForPerson(input.user.mcpUser)
					? loadProfileData(
							input.env,
							input.request,
							input.user.username,
							undefined,
							{ query: '', limit: 5 },
						)
					: loadOrgRepositoriesData({ ...input, query: '', limit: 5 }),
				loadAccountActivityData({
					...input,
					selectedRunId: null,
					viewFilter: 'recent',
					statusFilter: 'all',
					surfaceFilter: 'all',
					triageFilter: 'all',
					cursor: null,
				}),
				loadAccountJobsData({ ...input, selectedJobId: null }),
				loadWorkspaceRunCharts({
					env: input.env,
					userId: input.user.request.org.id,
				}),
				loadOrgUsagePageResult({
					...input,
					orgSlug: slug,
					credits: null,
					error: null,
					topup: null,
					sessionId: null,
				}),
			])
		if (!repositories) throw notFound()
		// Total runs and Running match the chart window/filters. Open errors
		// stays Activity's untriaged count (live "is anything broken?") and is
		// labeled separately in the UI so it does not contradict Error bars.
		const chartTotals = overviewExecutionTotals(charts)
		return {
			slug,
			skillMetrics,
			charts,
			billing:
				usage.kind === 'data'
					? {
							whereItWent: usage.payload.whereItWent,
							includedCompute: usage.payload.includedCompute,
							creditsAlarm: usage.payload.creditsAlarm,
						}
					: null,
			repositories: repositories.packages,
			summary: {
				...activity.summary,
				since: charts.since,
				total: chartTotals.total,
				running: chartTotals.running,
				errors: activity.summary.errors,
			},
			runs: activity.runs.slice(0, 6),
			upcomingJobs: jobs.jobs
				.filter((job) => job.enabled && !job.killSwitchEnabled && !job.expired)
				.sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
				.slice(0, 4),
		}
	})

export const loadOrgRepositories = createServerFn({ method: 'GET' })
	.validator(
		slugInput.extend({
			query: z.string().default(''),
			limit: z.number().int().positive().max(100).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const input = await orgContext(data.slug, 'repositories')
		const [
			{ orgSectionDenial },
			{ personalOrgIdForPerson },
			{ loadOrgRepositoriesData },
			{ loadProfileData },
		] = await Promise.all([
			import('../../src/app/org-request-binding.ts'),
			import('../../src/orgs/personal-org-id.ts'),
			import('../../src/app/org-repositories-data.ts'),
			import('../../src/app/profile-data.ts'),
		])
		const binding = input.binding
		if (orgSectionDenial(binding, 'repositories')) throw notFound()
		const payload =
			binding.org.id === personalOrgIdForPerson(input.user.mcpUser)
				? await loadProfileData(
						input.env,
						input.request,
						input.user.username,
						undefined,
						{ query: data.query, limit: data.limit },
					)
				: await loadOrgRepositoriesData({
						...input,
						binding,
						query: data.query,
						limit: data.limit,
					})
		if (!payload) throw notFound()
		return payload
	})

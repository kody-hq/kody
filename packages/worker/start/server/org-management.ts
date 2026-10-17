import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
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
			throw new Error(access.error)
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
			throw new Error(access.error)
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
			throw new Error(access.error)
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
			throw new Error(access.error)
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
			throw new Error(access.error)
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
		const [{ personalOrgIdForPerson }] = await Promise.all([
			import('../../src/orgs/personal-org-id.ts'),
		])
		const resolution = input.binding
		const slug = resolution.org.slug ?? data.slug
		if (resolution.org.id !== personalOrgIdForPerson(input.user.mcpUser))
			throw redirect({ href: `/@${encodeURIComponent(slug)}` })

		return { slug }
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

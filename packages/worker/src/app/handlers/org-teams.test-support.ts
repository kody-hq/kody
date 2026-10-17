import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { resolveOrgManagementAccess } from '#app/org-management-access.ts'
import {
	loadOrgTeamsData,
	createOrganizationTeam,
	addOrganizationTeamMember,
	removeOrganizationTeamMember,
} from './org-teams.ts'
export * from './org-teams.ts'
export function testOrgTeamsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'team:read',
			})
			if (!access.ok) {
				return operationResult(
					{ ok: false, error: access.error },
					access.status,
				)
			}
			return operationResult(
				await loadOrgTeamsData({ env, user, org: access.org }),
			)
		},
	}
}

export function testOrgTeamsCreatePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await createOrganizationTeam({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgTeamsMemberAddPostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await addOrganizationTeamMember({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgTeamsMemberRemovePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await removeOrganizationTeamMember({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

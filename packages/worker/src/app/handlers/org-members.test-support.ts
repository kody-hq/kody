import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { resolveOrgManagementAccess } from '#app/org-management-access.ts'
import {
	revokeOrganizationMemberInvite,
	loadOrgMembersData,
	inviteOrganizationMember,
	createOrganizationInviteLink,
	revokeOrganizationInviteLink,
	removeOrganizationMember,
	setOrganizationMemberRole,
} from './org-members.ts'
export * from './org-members.ts'
export function testOrgMembersApiHandler(env: Env) {
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
				permission: 'member:read',
			})
			if (!access.ok) {
				return operationResult(
					{ ok: false, error: access.error },
					access.status,
				)
			}
			return operationResult(
				await loadOrgMembersData({ env, user, org: access.org }),
			)
		},
	}
}

export function testOrgMembersRolePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await setOrganizationMemberRole({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgMembersRemovePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await removeOrganizationMember({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgMembersInvitePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await inviteOrganizationMember({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgMembersInviteLinksPostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await createOrganizationInviteLink({
				request,
				env,
				user,
				...body,
			})
			return operationResult(result.data, result.status)
		},
	}
}

export function testOrgMembersInviteLinksRevokePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = (await readJsonObject(request)) ?? {}
			const result = await revokeOrganizationInviteLink({
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

export function testOrgMembersInviteRevokePostHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user)
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			const body = await readJsonObject(request)
			return revokeOrganizationMemberInvite({
				request,
				env,
				user,
				orgSlug: new URL(request.url).pathname.split('/')[1]!.slice(1),
				inviteId: String(body?.inviteId ?? ''),
			})
		},
	}
}

import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import {
	listPackageAppConnectedPeople,
	loadConnectedPeopleTarget,
	revokePackageAppConnectedPerson,
} from '#worker/package-app-connected-people.ts'
import { operationResult } from '../operation-result.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

type ConnectedPeopleInput = {
	env: Env
	request: Request
	user: AppUser
	username: string
	kodyId: string
}

/** The package app as the signed-in person manages it in the `:username` org. */
async function authorizedTarget(input: ConnectedPeopleInput) {
	const binding = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.username,
	)
	const callerContext = binding
		? createMcpCallerContext({
				baseUrl: getAppBaseUrl({
					env: input.env,
					requestUrl: input.request.url,
				}),
				source: { kind: 'session' },
				executionOrigin: 'interactive',
				user: input.user.mcpUser,
				orgBinding: binding,
			})
		: null
	const loaded = callerContext?.request
		? await loadConnectedPeopleTarget({
				env: input.env,
				request: callerContext.request,
				packageIdOrKodyId: input.kodyId,
			})
		: ({ kind: 'not_found' } as const)
	switch (loaded.kind) {
		case 'ok':
			return { target: loaded.target }
		case 'forbidden':
			return {
				error: operationResult(
					{
						ok: false as const,
						error:
							'You need Manage on this package to see who signed in to its app.',
					},
					403,
				),
			}
		case 'not_found':
		case 'no_app':
			return {
				error: operationResult(
					{ ok: false as const, error: 'Package app not found.' },
					404,
				),
			}
	}
}

export async function readPackageAppConnectedPeople(
	input: ConnectedPeopleInput & { page?: number },
) {
	const loaded = await authorizedTarget(input)
	if (loaded.error) return loaded.error
	return operationResult(
		await listPackageAppConnectedPeople({
			env: input.env,
			target: loaded.target,
			page: input.page,
		}),
	)
}

export async function revokePackageAppConnectedPersonForOwner(
	input: ConnectedPeopleInput & { grantId: string },
) {
	const loaded = await authorizedTarget(input)
	if (loaded.error) return loaded.error
	const revoked = await revokePackageAppConnectedPerson({
		env: input.env,
		target: loaded.target,
		grantId: input.grantId,
		audit: {
			email: input.user.email,
			ip: getRequestIp(input.request) ?? undefined,
			path: new URL(input.request.url).pathname,
		},
	})
	if (!revoked)
		return operationResult(
			{
				ok: false as const,
				error: 'That person is no longer signed in to this app.',
			},
			404,
		)
	return operationResult({ ok: true as const, grantId: input.grantId })
}

import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { loadResolvedRequestAuth } from './request-auth-cache.ts'

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const mutatingGetPaths = new Set(['/account/mcp-servers/oauth/callback'])

function accountDeletingResponse(status: number) {
	return Response.json(
		{
			error: {
				code: 'account_deleting',
				message:
					'Account deletion is in progress; user-owned writes are disabled.',
			},
		},
		{ status },
	)
}

/** Called only for protocol requests. Native server functions own their write leases. */
export async function withProtocolAccountWriteLease<T>(
	request: Request,
	env: Env,
	next: () => Promise<T>,
): Promise<T | Response> {
	const url = new URL(request.url)
	const mutating =
		unsafeMethods.has(request.method) || mutatingGetPaths.has(url.pathname)
	if (!mutating) {
		return await next()
	}
	return withAccountRequestWriteLease(request, env, next)
}

/** Share deletion fencing between explicit native writes and HTTP protocols. */
export async function withAccountRequestWriteLease<T>(
	request: Request,
	env: Env,
	write: () => Promise<T>,
): Promise<T | Response> {
	const url = new URL(request.url)
	const auth = await loadResolvedRequestAuth(request, env)
	if (!auth.user) return await write()
	if (auth.user.accountDeleting) return accountDeletingResponse(409)
	try {
		return await withAccountWriteLease({
			db: env.APP_DB,
			stableUserId: personalOrgIdForPerson(auth.user.mcpUser),
			holder: `web:${request.method} ${url.pathname}`,
			env,
			write,
		})
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) {
			return accountDeletingResponse(409)
		}
		if (error instanceof AccountWriteLeaseLostError) {
			return accountDeletingResponse(503)
		}
		throw error
	}
}

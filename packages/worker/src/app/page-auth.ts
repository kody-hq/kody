import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { type RoleName } from '#universal/permissions.ts'

export async function requirePageSession(
	request: Request,
): Promise<Response | null> {
	const { session } = await readAuthSessionResult(request)
	if (!session) {
		return redirectToLogin(request)
	}

	return null
}

export async function requireAuthenticatedPageUser(
	request: Request,
	env: Env,
	options: { redirectTo?: string; resourceRequest?: Request } = {},
): Promise<AuthenticatedAppUser | Response> {
	const { session } = await readAuthSessionResult(request)
	if (!session) {
		return redirectToLogin(request, options)
	}

	const user = await readAuthenticatedAppUser(request, env, {
		prefetchFeatureFlags: true,
		resourceRequest: options.resourceRequest,
	})
	if (user) {
		return user
	}

	const resolved = await loadResolvedRequestAuth(request, env)
	if (resolved.user?.accountDeleting) {
		return redirectToLogin(request, {
			...options,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
		})
	}

	return redirectToLoginWhenUnauthenticated(request, env, options)
}

export async function requirePageUserWithRole(
	request: Request,
	env: Env,
	role: RoleName,
): Promise<AuthenticatedAppUser | Response> {
	try {
		return await requireUserWithRole(request, env, role, {
			prefetchFeatureFlags: true,
		})
	} catch (error) {
		if (error instanceof Response) {
			return error
		}
		throw error
	}
}

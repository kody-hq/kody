import type { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import type { PackageMappingScope } from '#worker/credentials/package-credential-mappings.ts'
import { loadPackageMappingScopeForRequest } from '#worker/credentials/package-mapping-scope-access.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

/**
 * The mapping scope for `/profiles/:username/packages/:kodyId/…` as the
 * signed-in person sees it, bound to the `:username` org. Null when the org
 * or package is not theirs to see, or they lack `package:execute` on it, so
 * callers answer 404 without leaking which.
 */
export async function loadPackageMappingScopeForViewer(input: {
	env: Env
	request: Request
	user: AppUser
	username: string
	kodyId: string
}): Promise<PackageMappingScope | null> {
	const { env, user } = input
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		input.username,
	)
	if (!binding) return null
	return await loadPackageMappingScopeForRequest({
		env,
		baseUrl: getAppBaseUrl({ env, requestUrl: input.request.url }),
		request: deriveRequestContext({
			user: user.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		}),
		packageIdOrKodyId: input.kodyId,
	})
}

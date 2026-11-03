import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	loadPackageMappingScope,
	type PackageMappingScope,
} from './package-credential-mappings.ts'

/**
 * The mapping scope for a package in the request's org. Null when the package
 * is not in that org or the caller lacks `package:execute` on it, so callers
 * can answer "not found" without leaking which.
 */
export async function loadPackageMappingScopeForRequest(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	packageIdOrKodyId: string
}): Promise<PackageMappingScope | null> {
	const { env, request } = input
	const savedPackage = await resolveSavedPackage({
		db: env.APP_DB,
		userId: request.org.id,
		packageIdOrKodyId: input.packageIdOrKodyId.trim(),
	})
	if (!savedPackage) return null
	const access = await computeEffectivePermissions({ env, request })
	const resource = packageResource({
		id: savedPackage.id,
		userId: savedPackage.userId,
		label: savedPackage.kodyId,
	})
	if (!checkPermission(access, 'package:execute', resource).allowed) {
		return null
	}
	return await loadPackageMappingScope({
		env,
		baseUrl: input.baseUrl,
		request,
		savedPackage,
		canManage: checkPermission(access, 'package:write', resource).allowed,
	})
}

import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'

/**
 * A publish under a profile is refused when the profile chain cannot run a
 * package the new version imports (ADR 0092). Publishing never confers
 * access: runs still use the runner's own access. A person-level publish is
 * unchanged, since every run already checks imports against the runner.
 */
export async function assertProfileCanPublishImports(input: {
	env: Env
	request: RequestContext | null | undefined
	ownerUserId: string
	packageName: string
	dependencies: Parameters<typeof listKodyPackageDependencyNames>[0]
}): Promise<void> {
	const request = input.request
	if (!request?.credential.profileId) return
	const names = listKodyPackageDependencyNames(input.dependencies).filter(
		(name) => name !== input.packageName,
	)
	if (names.length === 0) return
	const access = await computeEffectivePermissions({ env: input.env, request })
	for (const name of names) {
		const row = await getSavedPackageByName(input.env.APP_DB, {
			userId: input.ownerUserId,
			name,
		})
		// A missing import is not a profile question: saves already accept it and
		// the run fails with SavedPackageNotFoundError, for profiles and people alike.
		if (!row) continue
		const decision = checkPermission(
			access,
			'package:execute',
			packageResource({ id: row.id, userId: row.userId, label: name }),
		)
		if (decision.allowed) continue
		throw new AuthorizationError({
			code: decision.error.code,
			permission: 'package:execute',
			orgId: decision.error.orgId,
			resource: decision.error.resource,
			message: `This version imports ${name}, which the publishing profile cannot run. ${decision.error.message}`,
		})
	}
}

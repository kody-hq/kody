import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { viewerIsSavedPackageOrgOwner } from '#app/package-viewer-access.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { adoptCommunityFork } from '#worker/community/service.ts'
import {
	packageMutationResult,
	type PackageMutationResult,
} from './package-mutation-result.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function adoptAccountPackageFork(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	packageId: string
	reviewNote: string
}): Promise<PackageMutationResult> {
	const packageId = input.packageId.trim()
	if (!packageId) {
		return packageMutationResult(
			{ ok: false, error: 'Package id is required.' },
			400,
		)
	}
	const savedPackage = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		packageId,
	)
	if (
		!savedPackage ||
		!(await viewerIsSavedPackageOrgOwner({
			env: input.env,
			viewer: input.user.mcpUser,
			ownerId: savedPackage.userId,
		}))
	) {
		return packageMutationResult(
			{ ok: false, error: 'Package not found.' },
			404,
		)
	}
	const ownerUserId = savedPackage.userId
	try {
		await adoptCommunityFork({
			env: input.env,
			userId: ownerUserId,
			packageId,
			reviewSummary: input.reviewNote.trim(),
		})
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return packageMutationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
	return packageMutationResult({ ok: true, packageId })
}

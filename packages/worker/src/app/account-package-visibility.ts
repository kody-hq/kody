import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import {
	packageMutationResult,
	type PackageMutationResult,
} from './package-mutation-result.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	publishCommunityListing,
	unpublishCommunityListing,
} from '#worker/community/service.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { updateSavedPackage } from '#worker/package-registry/repo.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function setAccountPackageVisibility(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	packageId: string
	visibility: string
	confirmName: string
}): Promise<PackageMutationResult> {
	const packageId = input.packageId.trim()
	const visibility = input.visibility.trim()
	const confirmName = input.confirmName.trim()
	if (!packageId) {
		return packageMutationResult(
			{ ok: false, error: 'Package id is required.' },
			400,
		)
	}
	if (visibility !== 'public' && visibility !== 'private') {
		return packageMutationResult(
			{ ok: false, error: 'Visibility must be public or private.' },
			400,
		)
	}

	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId,
		permission: 'package:publish',
	})
	if (!resolved.ok)
		return packageMutationResult(
			{ ok: false, error: 'Package not found.' },
			404,
		)
	const { savedPackage, ownerUserId, actorUserId } = resolved.package

	try {
		if (visibility === 'public') {
			if (confirmName !== savedPackage.kodyId) {
				return packageMutationResult(
					{
						ok: false,
						error: savedPackage.isPrivate
							? `Type the package slug "${savedPackage.kodyId}" to make it public. Anyone will be able to read and fork the default branch.`
							: `Type the package slug "${savedPackage.kodyId}" to update the public community listing to the current published commit.`,
					},
					400,
				)
			}
			// First publish and explicit visibility-public refresh call
			// publishCommunityListing. Promote also syncs an active listing via
			// finalizePublishedEntitySource.
			await publishCommunityListing({
				env: input.env,
				baseUrl: new URL(input.request.url).origin,
				userId: ownerUserId,
				actorUserId,
				packageId,
			})
		} else if (visibility === 'private' && !savedPackage.isPrivate) {
			if (confirmName !== savedPackage.kodyId) {
				return packageMutationResult(
					{
						ok: false,
						error: `Type the package slug "${savedPackage.kodyId}" to make it private. Public URLs will 404; existing forks keep their copies.`,
					},
					400,
				)
			}
			const listing = await getCommunityListingByOwnerAndPackage(
				input.env.APP_DB,
				{
					ownerUserId,
					packageId,
				},
			)
			if (listing && listing.status === 'active') {
				await unpublishCommunityListing({
					env: input.env,
					userId: ownerUserId,
					actorUserId,
					listingId: listing.id,
				})
			} else {
				const changed = await updateSavedPackage(input.env.APP_DB, {
					userId: ownerUserId,
					packageId,
					isPrivate: true,
				})
				if (!changed) {
					return packageMutationResult(
						{ ok: false, error: 'Package not found.' },
						404,
					)
				}
			}
		}
	} catch (error) {
		if (error instanceof CommunityActionError) {
			return packageMutationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}

	return packageMutationResult({ ok: true, packageId })
}

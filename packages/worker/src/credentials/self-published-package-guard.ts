import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { getLatestApprovedPackageApprovalRequest } from '#worker/package-capabilities/approval-requests-repo.ts'
import { isSelfPublishRequest } from '#worker/package-capabilities/went-public-approval.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { CredentialNeedUndeclaredError } from './credential-need-enforcement.ts'
const selfPublishedByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<SavedPackageRecord | null>>
>()

/** The package when it is internet-visible through self-publish, else null. */
async function loadSelfPublishedPackage(env: Env, packageId: string) {
	const saved = await getSavedPackageByIdInAnyOrg(env.APP_DB, packageId)
	if (!saved?.isInternetVisible) return null
	const wentPublic = await getLatestApprovedPackageApprovalRequest(env.APP_DB, {
		packageId,
		ownerUserId: saved.userId,
		reason: 'went_public',
	})
	return isSelfPublishRequest(wentPublic) ? saved : null
}

function selfPublishedPackageFor(
	env: Env,
	request: RequestContext | null,
	packageId: string,
) {
	if (!request) return loadSelfPublishedPackage(env, packageId)
	let byPackage = selfPublishedByRequest.get(request)
	if (!byPackage) {
		byPackage = new Map()
		selfPublishedByRequest.set(request, byPackage)
	}
	let loaded = byPackage.get(packageId)
	if (!loaded) {
		loaded = loadSelfPublishedPackage(env, packageId)
		byPackage.set(packageId, loaded)
		loaded.catch(() => byPackage.delete(packageId))
	}
	return loaded
}

/**
 * A package that went internet-visible without its owner's Approve click
 * (self-publish) declared no credential, so it may resolve none, by any
 * helper. This holds until the owner approves going public again, whatever
 * the package declares since. Checked in the credential door, so it also
 * covers by-name helpers that credential-need enforcement does not reach.
 */
export async function assertSelfPublishedPackageResolvesNothing(input: {
	env: Env
	request: RequestContext | null
	packageId: string | null | undefined
	credentialName: string
}) {
	const packageId = input.packageId?.trim()
	if (!packageId) return
	const saved = await selfPublishedPackageFor(
		input.env,
		input.request,
		packageId,
	)
	if (!saved) return
	throw new CredentialNeedUndeclaredError({
		key: input.credentialName,
		message: `Package ${saved.name} went internet-visible without its owner's approval because it declared no credentials, so it cannot use "${input.credentialName}". Declare it in kody.credentials, publish, then have the owner turn internet-visible off and approve turning it on again.`,
	})
}

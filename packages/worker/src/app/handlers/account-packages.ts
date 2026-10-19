import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import { adoptAccountPackageFork } from '#app/account-package-adopt.ts'
import {
	approveAccountPackageCapabilities,
	approveAccountPackageCapabilitiesAndGoPublic,
	approveAccountPackageCredentialNeeds,
	approveAccountPackageWentPublic,
	setAccountPackageInternetVisible,
} from '#app/account-package-capability-approval.ts'
import { deleteAccountPackage } from '#app/account-package-delete.ts'
import {
	approveAccountPackagePublish,
	lockAccountPackage,
	unlockAccountPackage,
} from '#app/account-package-publish-lock.ts'
import { setAccountPackageVisibility } from '#app/account-package-visibility.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import {
	packageMutationResult,
	type PackageMutationResult,
} from '#app/package-mutation-result.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { absorbCommunityForkUpstream } from '#worker/community/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'

/**
 * Compatibility HTTP adapter for retained Start client assets that still POST
 * action bodies to `/account/packages.json`. New website UI uses typed Start
 * server functions; this keeps the same auth and action behavior for the
 * asset-retention window.
 */
export function createAccountPackagesApiHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
		}

		if (request.method === 'GET' || request.method === 'HEAD') {
			const data = await loadAccountPackagesData({ env, request, user })
			return jsonResponse(data)
		}

		if (request.method !== 'POST') {
			return jsonResponse(
				{ ok: false, error: 'Method not allowed.' },
				{
					status: 405,
					headers: { Allow: 'GET, HEAD, POST' },
				},
			)
		}

		const auth = await loadResolvedRequestAuth(request, env)
		if (auth.user?.accountDeleting) {
			return jsonResponse(
				{ ok: false, error: 'Account deletion is in progress.' },
				409,
			)
		}

		return withAccountWriteLease({
			db: env.APP_DB,
			stableUserId: personalOrgIdForPerson(user.mcpUser),
			holder: 'website:account-packages-json',
			env,
			write: async () => {
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object' || Array.isArray(body)) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const result = await dispatchAccountPackageAction({
					env,
					request,
					user,
					body,
				})
				return jsonResponse(result.data, result.status)
			},
		})
	}
}

async function dispatchAccountPackageAction(input: {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}): Promise<PackageMutationResult> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	const context = {
		env: input.env,
		request: input.request,
		user: input.user,
		packageId,
	}

	switch (action) {
		case 'lock':
			return lockAccountPackage(context)
		case 'unlock':
			return unlockAccountPackage(context)
		case 'approve-publish':
			return approveAccountPackagePublish({
				...context,
				commit: readTrimmedStringOrEmpty(input.body, 'commit'),
			})
		case 'set-visibility': {
			const visibility = readTrimmedStringOrEmpty(input.body, 'visibility')
			if (visibility !== 'public' && visibility !== 'private') {
				return packageMutationResult(
					{ ok: false, error: 'Visibility must be public or private.' },
					400,
				)
			}
			return setAccountPackageVisibility({
				...context,
				visibility,
				confirmName: readTrimmedStringOrEmpty(input.body, 'confirmName'),
			})
		}
		case 'set-internet-visible':
			return setAccountPackageInternetVisible({
				...context,
				internetVisible:
					'internetVisible' in input.body &&
					input.body.internetVisible === true,
				confirmName: readTrimmedStringOrEmpty(input.body, 'confirmName'),
			})
		case 'approve-capabilities':
			return approveAccountPackageCapabilities({
				...context,
				fingerprint: readTrimmedStringOrEmpty(input.body, 'fingerprint'),
			})
		case 'approve-capabilities-and-go-public':
			return approveAccountPackageCapabilitiesAndGoPublic({
				...context,
				fingerprint: readTrimmedStringOrEmpty(input.body, 'fingerprint'),
				requestId: readTrimmedStringOrEmpty(input.body, 'requestId'),
			})
		case 'approve-credential-needs':
			return approveAccountPackageCredentialNeeds({
				...context,
				requestId: readTrimmedStringOrEmpty(input.body, 'requestId'),
			})
		case 'approve-went-public':
			return approveAccountPackageWentPublic({
				...context,
				requestId: readTrimmedStringOrEmpty(input.body, 'requestId'),
			})
		case 'delete':
			return deleteAccountPackage({
				env: input.env,
				user: input.user,
				packageId,
				confirmName: readTrimmedStringOrEmpty(input.body, 'confirmName'),
			})
		case 'adopt-community-fork':
			return adoptAccountPackageFork({
				...context,
				reviewNote: readTrimmedStringOrEmpty(input.body, 'reviewNote'),
			})
		case 'absorb-listing': {
			if (!packageId) {
				return packageMutationResult(
					{ ok: false, error: 'Package id is required.' },
					400,
				)
			}
			const resolved = await loadWritableAccountSavedPackage({
				env: input.env,
				user: input.user,
				packageId,
				permission: 'package:write',
			})
			if (!resolved.ok) {
				return packageMutationResult(
					{ ok: false, error: 'Package not found.' },
					404,
				)
			}
			try {
				await absorbCommunityForkUpstream({
					env: input.env,
					userId: resolved.package.ownerUserId,
					packageId,
				})
			} catch (error) {
				if (error instanceof CommunityActionError) {
					return packageMutationResult({ ok: false, error: error.message }, 400)
				}
				throw error
			}
			return packageMutationResult({ ok: true, packageId })
		}
		default:
			return packageMutationResult({ ok: false, error: 'Invalid action.' }, 400)
	}
}

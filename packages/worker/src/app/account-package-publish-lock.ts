import { loadWritableAccountSavedPackage } from '#app/account-package-write-access.ts'
import { reloadAccountPackagesAfterWrite } from '#app/account-packages-data.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadPublicTreeFiles } from '#app/package-files-data.ts'
import { buildPublishCommitDiff } from '#app/package-publish-diff.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type AccountPackageApprovePublishLoaderData } from '#universal/loader-data.ts'
import { getPackageTreeHref } from '#universal/package-files.ts'
import { routes } from '#universal/routes.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	isGitCommitSha,
	isSavedPackageLocked,
} from '#worker/package-registry/package-publish-lock.ts'
import { setSavedPackageLockedAt } from '#worker/package-registry/repo.ts'
import { readArtifactTreeAtCommit } from '#worker/repo/artifact-file.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { resolveListingBehindPublishHint } from '#worker/community/resolve-listing-behind-publish-hint.ts'
import { loadSecretMountCompatNotice } from '#worker/package-runtime/secret-mount-compat.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountPackageApprovePublishData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	packageId: string
}): Promise<
	AccountPackageApprovePublishLoaderData | { ok: false; error: string }
> {
	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId: input.packageId,
		permission: 'package:write',
	})
	if (!resolved.ok) {
		return { ok: false, error: 'Package not found.' }
	}
	const { savedPackage, ownerUserId } = resolved.package
	const source = await getEntitySourceById(
		input.env.APP_DB,
		savedPackage.sourceId,
	)
	if (!source || source.user_id !== ownerUserId) {
		return { ok: false, error: 'Package source not found.' }
	}
	const requestUrl = new URL(input.request.url)
	const requestedCommit = requestUrl.searchParams.get('commit')?.trim() ?? ''
	const pendingIsDefaultHead = !requestedCommit
	let pendingCommit: string | null = null
	if (requestedCommit) {
		if (!isGitCommitSha(requestedCommit)) {
			return { ok: false, error: 'The commit in this URL is not a git SHA.' }
		}
		pendingCommit = requestedCommit
	} else {
		const head = await resolveArtifactSourceHead(input.env, source.repo_id)
		pendingCommit = head.commit
	}
	const publishedCommit = source.published_commit
	const alreadyPublished =
		pendingCommit != null &&
		publishedCommit != null &&
		pendingCommit === publishedCommit
	const [publishedFiles, pendingFiles] = alreadyPublished
		? [
				{ files: {}, resolved: true },
				{ files: {}, resolved: true },
			]
		: await Promise.all([
				loadPublishCompareTree({
					env: input.env,
					request: input.request,
					sourceId: source.id,
					sourceRepoId: source.repo_id,
					commit: publishedCommit,
				}),
				loadPublishCompareTree({
					env: input.env,
					request: input.request,
					sourceId: source.id,
					sourceRepoId: source.repo_id,
					commit: pendingCommit,
				}),
			])
	const unpublishedCompare = publishedCommit != null && !publishedFiles.resolved
	const pendingMissing = !pendingFiles.resolved
	const ownerBinding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		ownerUserId,
	)
	const ownerUsername = ownerBinding?.org.slug ?? input.user.username
	// Listing auto-follows promote. A behind hint here means sync or backfill
	// has not caught up yet — rare, and not a manual republish step.
	const listing =
		publishedCommit == null
			? null
			: await resolveListingBehindPublishHint({
					db: input.env.APP_DB,
					ownerUserId,
					packageId: savedPackage.id,
					ownerUsername,
					kodyId: savedPackage.kodyId,
					promotedCommit: publishedCommit,
				})
	return {
		ok: true,
		email: input.user.email,
		package: {
			id: savedPackage.id,
			name: savedPackage.name,
			kodyId: savedPackage.kodyId,
			sourceId: savedPackage.sourceId,
			lockedAt: savedPackage.lockedAt,
		},
		publishedCommit,
		pendingCommit,
		alreadyPublished,
		pendingIsDefaultHead,
		filesHref: getPackageTreeHref({
			username: ownerUsername,
			kodyId: savedPackage.kodyId,
		}),
		packageHref: routes.communityPackage.href({
			username: ownerUsername,
			kodyId: savedPackage.kodyId,
		}),
		listing,
		listingWillLagAfterPromote: false,
		secretMountCompatNotice:
			pendingCommit == null
				? null
				: await loadSecretMountCompatNotice({
						env: input.env,
						userId: ownerUserId,
						sourceId: source.id,
						nextCommit: pendingCommit,
						nextFiles: pendingFiles.files,
						previousCommit: publishedCommit,
						previousFiles: publishedFiles.files,
					}),
		diff:
			unpublishedCompare || pendingMissing
				? { files: [], omittedCount: 0 }
				: buildPublishCommitDiff(publishedFiles.files, pendingFiles.files),
	}
}

async function loadPublishCompareTree(input: {
	env: Env
	request: Request
	sourceId: string
	sourceRepoId: string | null
	commit: string | null
}): Promise<{ files: Record<string, string>; resolved: boolean }> {
	if (!input.commit) return { files: {}, resolved: false }
	const publicTree = await loadPublicTreeFiles({
		env: input.env,
		request: input.request,
		sourceId: input.sourceId,
		sourceRepoId: input.sourceRepoId,
		commit: input.commit,
		pinnedCommit: input.commit,
	})
	if (Object.keys(publicTree.files).length > 0) {
		return { files: publicTree.files, resolved: true }
	}
	if (!input.sourceRepoId) return { files: {}, resolved: false }
	try {
		const files = await readArtifactTreeAtCommit({
			env: input.env,
			repoId: input.sourceRepoId,
			commit: input.commit,
		})
		if (files == null) return { files: {}, resolved: false }
		return { files, resolved: true }
	} catch {
		return { files: {}, resolved: false }
	}
}

export async function handleAccountPackagePublishLockAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	body: object
}): Promise<Response | null> {
	const action = readTrimmedStringOrEmpty(input.body, 'action')
	if (
		action !== 'lock' &&
		action !== 'unlock' &&
		action !== 'approve-publish'
	) {
		return null
	}
	const packageId = readTrimmedStringOrEmpty(input.body, 'packageId')
	if (!packageId) {
		return jsonResponse({ ok: false, error: 'Package id is required.' }, 400)
	}
	const resolved = await loadWritableAccountSavedPackage({
		env: input.env,
		user: input.user,
		packageId,
		permission: 'package:write',
	})
	if (!resolved.ok) return resolved.response
	const { savedPackage, ownerUserId, actorUserId } = resolved.package

	if (action === 'lock' || action === 'unlock') {
		if (action === 'lock' && isSavedPackageLocked(savedPackage.lockedAt)) {
			return jsonResponse(
				await reloadAccountPackagesAfterWrite({
					env: input.env,
					request: input.request,
					user: input.user,
					packageId,
					ownerUserId,
				}),
			)
		}
		const changed = await setSavedPackageLockedAt(input.env.APP_DB, {
			userId: ownerUserId,
			packageId,
			lockedAt: action === 'lock' ? new Date().toISOString() : null,
		})
		if (!changed) {
			return jsonResponse({ ok: false, error: 'Package not found.' }, 404)
		}
		return jsonResponse(
			await reloadAccountPackagesAfterWrite({
				env: input.env,
				request: input.request,
				user: input.user,
				packageId,
				ownerUserId,
			}),
		)
	}

	const commit = readTrimmedStringOrEmpty(input.body, 'commit')
	if (!isGitCommitSha(commit)) {
		return jsonResponse(
			{
				ok: false,
				error: 'A git commit SHA is required to approve this publish.',
			},
			400,
		)
	}
	const locked = isSavedPackageLocked(savedPackage.lockedAt)
	const source = await getEntitySourceById(
		input.env.APP_DB,
		savedPackage.sourceId,
	)
	if (!source || source.user_id !== ownerUserId) {
		return jsonResponse({ ok: false, error: 'Package source not found.' }, 404)
	}
	const sessionId = `approve-publish-${savedPackage.id}`
	const publishResult = await repoSessionRpc(
		input.env,
		sessionId,
	).publishFromExternalRef({
		sessionId,
		sourceId: source.id,
		userId: ownerUserId,
		newCommit: commit,
		...(locked ? { allowLockedPublish: true } : {}),
		requestedByUserId: actorUserId,
		// Owner explicitly chose this commit on approve-publish. If a
		// published-only fleet migration advanced published_commit to a sibling
		// of pending HEAD, this is not a fast-forward; allowForce + overwrite
		// confirmation (this click) still requires a restorable backup.
		allowForce: true,
		destructiveOverwriteConfirmed: true,
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		rebuildPackageArtifacts: true,
	})
	switch (publishResult.status) {
		case 'published':
		case 'already_published': {
			const packagesPayload = await reloadAccountPackagesAfterWrite({
				env: input.env,
				request: input.request,
				user: input.user,
				packageId,
				ownerUserId,
			})
			const ownerBinding = await loadOrgBindingForOrg(
				input.env.APP_DB,
				input.user.mcpUser.userId,
				ownerUserId,
			)
			const ownerUsername = ownerBinding?.org.slug ?? input.user.username
			const listing = await resolveListingBehindPublishHint({
				db: input.env.APP_DB,
				ownerUserId,
				packageId,
				ownerUsername,
				kodyId: savedPackage.kodyId,
				promotedCommit: commit,
			})
			const secretMountCompat = await loadSecretMountCompatNotice({
				env: input.env,
				userId: ownerUserId,
				sourceId: source.id,
				nextCommit: commit,
				previousCommit: source.published_commit,
			})
			return jsonResponse({
				...packagesPayload,
				listing,
				secret_mount_compat: secretMountCompat,
			})
		}
		case 'checks_failed':
			return jsonResponse(
				{
					ok: false,
					error:
						'Publish checks failed for this commit. Fix the package and try again.',
					failed_checks: publishResult.failed_checks,
				},
				400,
			)
		case 'not_fast_forward':
			return jsonResponse({ ok: false, error: publishResult.message }, 400)
		case 'locked':
			return jsonResponse(
				{
					ok: false,
					error: 'Could not promote this locked package. Reload and try again.',
				},
				409,
			)
		case 'approval_required':
			return jsonResponse({ ok: false, error: publishResult.message }, 409)
		default: {
			const exhaustive: never = publishResult
			throw new Error(`Unknown approve-publish status: ${String(exhaustive)}`)
		}
	}
}

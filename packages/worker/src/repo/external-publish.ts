import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import * as Sentry from '@sentry/cloudflare'
import { refreshCommunityIconForPackagePublish } from '#worker/community/community-icon.ts'
import { syncActiveCommunityListingToPublishedCommit } from '#worker/community/sync-active-community-listing.ts'
import { notifyFollowsOfPublishedPackage } from '#worker/follow/notify.ts'
import { refreshIdentityIconForSource } from '#worker/repo/identity-icon.ts'
import {
	createPackagePublishLockedError,
	loadLockedSavedPackage,
} from '#worker/package-registry/package-publish-lock.ts'
import { requireCredentialNeedsApproval } from '#worker/credentials/credential-needs-approval.ts'
import { storePublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { storePublishedCredentialStamp } from '#worker/credentials/credential-stamp-store.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	deletePublishedSourceSnapshot,
	hasPublishedRuntimeArtifacts,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { runRepoChecks } from './checks.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'
import {
	type EntitySourceRow,
	type RepoExternalPublishResult,
} from './types.ts'
import { loadSecretMountCompatNotice } from '#worker/package-runtime/secret-mount-compat.ts'
import { buildCredentialAllowedPackagesPublishWarningNotice } from '#worker/credentials/credential-allowed-packages-publish-warning.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { assertPackageSourceOverwriteAllowed } from './source-safety-policy.ts'

export type RepoPublishWorkspace = {
	readFile(path: string): Promise<string | null>
	glob(pattern: string): Promise<Array<{ path: string; type: string }>>
}

export type FinalizePublishedSourceInput = {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	files: Record<string, string>
	baseUrl?: string
	rebuildPackageArtifacts?: boolean
	allowLockedPublish?: boolean
	/** Actor who requested the publish; forwarded to listing auto-follow ban checks. */
	actorUserId?: string
}

export async function finalizePublishedEntitySource(
	input: FinalizePublishedSourceInput,
) {
	if (
		input.source.entity_kind === 'package' &&
		input.allowLockedPublish !== true
	) {
		const lockedPackage = await loadLockedSavedPackage({
			db: input.env.APP_DB,
			userId: input.source.user_id,
			packageId: input.source.entity_id,
		})
		if (lockedPackage) {
			throw createPackagePublishLockedError({
				savedPackage: lockedPackage,
				pendingCommit: input.publishedCommit,
				currentPublishedCommit: input.source.published_commit,
			})
		}
	}
	const previousPublishedCommit = input.source.published_commit
	let wrotePublishedSnapshot = false
	// Persist the published source snapshot *before* flipping
	// `published_commit`. Advertising the new tip while KV still lacks the
	// matching snapshot leaves a window where imports and packageGet fail
	// with "Published snapshot … was not found" (platform feedback /
	// promote race). The snapshot key is keyed by commit, so it does not
	// require the D1 pointer to move first. Previous tip keeps serving until
	// this write succeeds and D1 advances.
	if (hasPublishedRuntimeArtifacts(input.env)) {
		await writePublishedSourceSnapshot({
			env: input.env,
			source: {
				...input.source,
				published_commit: input.publishedCommit,
			},
			files: input.files,
		})
		wrotePublishedSnapshot = true
	}
	try {
		await updateEntitySource(input.env.APP_DB, {
			id: input.source.id,
			userId: input.source.user_id,
			publishedCommit: input.publishedCommit,
			manifestPath: input.source.manifest_path,
			sourceRoot: input.source.source_root,
			externalCheckUntil: null,
		})
	} catch (pointerError) {
		// Orphan KV for a never-advertised tip is harmless but cheap to
		// clean when the commit moved. Same-commit rewrites keep the live
		// key. Re-read D1 first: a concurrent finalize of the same tip may
		// have already advertised it, and deleting the shared commit-scoped
		// key would wipe that winner's snapshot.
		if (
			wrotePublishedSnapshot &&
			previousPublishedCommit !== input.publishedCommit
		) {
			try {
				const live = await getEntitySourceById(
					input.env.APP_DB,
					input.source.id,
				)
				if (live?.published_commit !== input.publishedCommit) {
					await deletePublishedSourceSnapshot({
						env: input.env,
						sourceId: input.source.id,
						publishedCommit: input.publishedCommit,
					})
				}
			} catch (cleanupError) {
				Sentry.captureException(cleanupError, {
					tags: {
						scope: 'repo.publishFromExternalRef.cleanup-after-pointer-failure',
					},
					extra: {
						sourceId: input.source.id,
						previousPublishedCommit,
						attemptedPublishedCommit: input.publishedCommit,
					},
				})
			}
		}
		throw pointerError
	}
	try {
		await refreshIdentityIconForSource({
			env: input.env,
			source: {
				...input.source,
				published_commit: input.publishedCommit,
			},
			iconCommit: input.publishedCommit,
			indexLiveHead: input.source.entity_kind === 'repo',
		})
	} catch (error) {
		console.error(
			'identity-icon-publish-refresh-failed',
			input.source.entity_id,
			error,
		)
	}
	if (input.source.entity_kind !== 'package') return
	if (wrotePublishedSnapshot) {
		await storePublishedCredentialNeeds({
			env: input.env,
			source: input.source,
			publishedCommit: input.publishedCommit,
			files: input.files,
		})
		await storePublishedCredentialStamp({
			env: input.env,
			source: input.source,
			publishedCommit: input.publishedCommit,
			files: input.files,
		})
	}
	try {
		await refreshSavedPackageProjection({
			env: input.env,
			baseUrl: input.baseUrl ?? input.source.source_root,
			userId: input.source.user_id,
			// No account email in this publish path; plan lookup fails open per entitlements.md.
			packageId: input.source.entity_id,
			sourceId: input.source.id,
			rebuildArtifacts: input.rebuildPackageArtifacts ?? true,
			// Always pass the published file set so skills indexing runs even
			// when artifact rebuild is deferred (`rebuildArtifacts: false`).
			sourceFiles: input.files,
		})
	} catch (projectionError) {
		try {
			await updateEntitySource(input.env.APP_DB, {
				id: input.source.id,
				userId: input.source.user_id,
				publishedCommit: previousPublishedCommit,
				manifestPath: input.source.manifest_path,
				sourceRoot: input.source.source_root,
				externalCheckUntil: input.source.external_check_until,
			})
			// Same-commit finalize (no-op publish, promote, published-only
			// sync with a clean tree) overwrites the live snapshot key. If
			// projection then fails, deleting that key would leave
			// published_commit pointing at a commit with no KV snapshot —
			// permanent in production where the artifact-API fallback is
			// off (#3497 / KODY-97). Keep the rewritten snapshot when the
			// commit did not move; D1 still pins that commit.
			if (
				wrotePublishedSnapshot &&
				previousPublishedCommit !== input.publishedCommit
			) {
				await deletePublishedSourceSnapshot({
					env: input.env,
					sourceId: input.source.id,
					publishedCommit: input.publishedCommit,
				})
			}
		} catch (revertError) {
			Sentry.captureException(revertError, {
				tags: {
					scope: 'repo.publishFromExternalRef.revert-after-projection-failure',
				},
				extra: {
					sourceId: input.source.id,
					previousPublishedCommit,
					attemptedPublishedCommit: input.publishedCommit,
				},
			})
		}
		throw projectionError
	}
	const listingBaseUrl = input.baseUrl ?? input.source.source_root
	// Best-effort: an active community listing must follow the runtime pin.
	// Failures must not unwind an otherwise successful publish — the scheduled
	// listing-behind backfill retries stuck rows.
	let listingSynced = false
	try {
		const syncResult = await syncActiveCommunityListingToPublishedCommit({
			env: input.env,
			baseUrl: listingBaseUrl,
			ownerUserId: input.source.user_id,
			packageId: input.source.entity_id,
			publishedCommit: input.publishedCommit,
			actorUserId: input.actorUserId,
		})
		listingSynced = syncResult === 'synced'
	} catch (error) {
		console.error(
			'community-listing-publish-sync-failed',
			input.source.entity_id,
			error,
		)
	}
	// A synced listing republish already notified follows (and the fork
	// alias) from publishCommunityListing. Otherwise the published commit
	// itself is the version move.
	if (previousPublishedCommit !== input.publishedCommit && !listingSynced) {
		await notifyFollowsOfPublishedPackage({
			env: input.env,
			ownerId: input.source.user_id,
			packageId: input.source.entity_id,
			previousCommit: previousPublishedCommit,
			publishedCommit: input.publishedCommit,
			publishedAt: new Date().toISOString(),
		})
	}
	// Best-effort: an active community listing derives its public icon from
	// the package's published commit, so superseded cached icon revisions are
	// dropped and the public listing cache is invalidated. Failures must not
	// unwind an otherwise successful publish.
	try {
		await refreshCommunityIconForPackagePublish({
			env: input.env,
			userId: input.source.user_id,
			packageId: input.source.entity_id,
			publishedCommit: input.publishedCommit,
		})
	} catch (error) {
		console.error(
			'community-icon-publish-refresh-failed',
			input.source.entity_id,
			error,
		)
	}
}

export async function publishFromExternalRef(input: {
	env: Env
	sourceId: string
	userId: OwnerId
	newCommit: string
	isFastForward(input: { previousCommit: string }): Promise<boolean>
	allowForce?: boolean
	destructiveOverwriteConfirmed?: boolean
	workspace: RepoPublishWorkspace
	files?: Record<string, string>
	baseUrl: string
	manifestPath?: string
	sourceRoot?: string
	runId?: string
	rebuildPackageArtifacts?: boolean
	expectedPackageScope?: string
	allowLockedPublish?: boolean
	/** The owner approved this commit's credential needs (or a platform rewrite). */
	credentialNeedsApproved?: boolean
	requestedByUserId?: string | null
	phaseTimings?: PublishPhaseTimings
	deferBundleCheckToRebuild?: boolean
}): Promise<RepoExternalPublishResult> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error('Repo source was not found for this user.')
	}
	if (source.entity_kind === 'repo') {
		throw new Error(
			'Plain repos are live-at-HEAD and do not use external publish reconciliation.',
		)
	}
	if (source.published_commit === input.newCommit) {
		return {
			status: 'already_published',
			published_commit: source.published_commit,
		}
	}
	if (source.published_commit) {
		const isFastForward = await input.isFastForward({
			previousCommit: source.published_commit,
		})
		if (!isFastForward && !input.allowForce) {
			return {
				status: 'not_fast_forward',
				previous_commit: source.published_commit,
				published_commit: input.newCommit,
				message:
					'The external Artifacts HEAD is not a descendant of the current published commit. Retry only after satisfying the package source safety gate and setting allow_force with explicit destructive overwrite confirmation.',
			}
		}
		if (!isFastForward) {
			await assertPackageSourceOverwriteAllowed({
				env: input.env,
				userId: input.userId,
				source,
				operation: 'packagePublishExternalPush force publish',
				confirmed: input.destructiveOverwriteConfirmed,
			})
		}
	}
	const lockedPackage =
		source.entity_kind === 'package' && input.allowLockedPublish !== true
			? await loadLockedSavedPackage({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: source.entity_id,
				})
			: null
	// Locked publishes return after checks and never rebuild, so they must
	// still pay for full callable/importable esbuild. Defer only when rebuild
	// will run (unlocked, or allowLockedPublish).
	const deferBundleCheckToRebuild =
		input.deferBundleCheckToRebuild === true && lockedPackage == null
	const checks = await runRepoChecks({
		workspace: input.workspace,
		manifestPath: input.manifestPath ?? source.manifest_path,
		sourceRoot: input.sourceRoot ?? source.source_root,
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: source.id,
		expectedPackageScope: input.expectedPackageScope,
		phaseTimings: input.phaseTimings,
		...(deferBundleCheckToRebuild ? { deferBundleCheckToRebuild: true } : {}),
	})
	const runId = input.runId ?? crypto.randomUUID()
	if (!checks.ok) {
		return {
			status: 'checks_failed',
			failed_checks: checks.results.filter((check) => !check.ok),
			manifest: checks.manifest,
			run_id: runId,
		}
	}
	const pendingFiles = input.files ?? checks.sourceFiles
	const secretMountCompat =
		source.entity_kind === 'package'
			? await loadSecretMountCompatNotice({
					env: input.env,
					userId: input.userId,
					sourceId: source.id,
					nextCommit: input.newCommit,
					nextFiles: pendingFiles,
					previousCommit: source.published_commit,
					sourceRoot: source.source_root,
				})
			: null
	const savedPackageForNotice =
		source.entity_kind === 'package'
			? await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId: source.entity_id,
				})
			: null
	const allowedPackagesPublishNotice =
		savedPackageForNotice == null
			? null
			: await buildCredentialAllowedPackagesPublishWarningNotice({
					env: input.env,
					baseUrl: input.baseUrl ?? getAppBaseUrl({ env: input.env }),
					userId: input.userId,
					packageId: savedPackageForNotice.id,
					packageDisplayName: savedPackageForNotice.name,
					kodyId: savedPackageForNotice.kodyId,
					files: pendingFiles,
					slots: checks.manifest?.kody?.credentials,
				})
	const publishNotices = {
		...(secretMountCompat ? { secret_mount_compat: secretMountCompat } : {}),
		...(allowedPackagesPublishNotice
			? { allowed_packages_publish_notice: allowedPackagesPublishNotice }
			: {}),
	}
	if (lockedPackage) {
		const error = createPackagePublishLockedError({
			savedPackage: lockedPackage,
			pendingCommit: input.newCommit,
			currentPublishedCommit: source.published_commit,
		})
		return {
			status: 'locked',
			previous_commit: source.published_commit,
			pending_commit: input.newCommit,
			message: error.message,
			packageId: lockedPackage.id,
			packageName: lockedPackage.name,
			...publishNotices,
		}
	}
	const approval =
		input.credentialNeedsApproved === true
			? null
			: await requireCredentialNeedsApproval({
					env: input.env,
					source,
					pendingCommit: input.newCommit,
					files: pendingFiles,
					requestedByUserId: input.requestedByUserId,
					pausedExternalPublish: {
						allowForce: input.allowForce === true,
						destructiveOverwriteConfirmed:
							input.destructiveOverwriteConfirmed === true,
					},
				})
	if (approval) {
		return {
			status: 'approval_required',
			previous_commit: source.published_commit,
			pending_commit: input.newCommit,
			message: approval.message,
			approval,
			...publishNotices,
		}
	}
	await finalizePublishedEntitySource({
		env: input.env,
		source,
		publishedCommit: input.newCommit,
		files: input.files ?? checks.sourceFiles,
		baseUrl: input.baseUrl,
		rebuildPackageArtifacts: input.rebuildPackageArtifacts,
		allowLockedPublish: input.allowLockedPublish,
		actorUserId: input.requestedByUserId ?? undefined,
	})
	return {
		status: 'published',
		previous_commit: source.published_commit,
		published_commit: input.newCommit,
		manifest: checks.manifest,
		checks: checks.results,
		...publishNotices,
	}
}

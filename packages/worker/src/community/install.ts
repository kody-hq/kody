import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	createSnapshotFilesWorkspace,
	runRepoChecks,
	type RepoCheckResult,
} from '#worker/repo/checks.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	buildAlreadyForkedMessage,
	persistPreparedCommunityFork,
	prepareCommunityFork,
	runIdempotentCommunityFork,
} from './service.ts'
import {
	type CommunityForkActor,
	type CommunityForkRecord,
	type CrossScopeReference,
} from './types.ts'

type InstallProgressUpdate = {
	progress: number
	total?: number
	message?: string
}

type ReportInstallProgress = (
	update: InstallProgressUpdate,
) => void | Promise<void>

async function reportInstallProgress(
	reportProgress: ReportInstallProgress | null | undefined,
	update: InstallProgressUpdate,
) {
	if (!reportProgress) return
	await reportProgress(update)
}

function logInstallPhaseTiming(input: {
	phase: string
	durationMs: number
	listingId: string
	packageId?: string
	filesCount?: number
	status?: string
}) {
	console.info(
		JSON.stringify({
			message: 'community-phase-timing',
			...input,
		}),
	)
}

type InstallForkSummary = {
	forkId: string
	packageId: string
	sourceId: string
	targetKodyId: string
	targetName: string
	originCommit: string
	/**
	 * True when the account already had a fork of this listing (or one was
	 * in flight and finished while this request waited). Nothing new was
	 * created; `message` says so.
	 */
	alreadyInstalled?: boolean
	message?: string
}

export type InstallCommunityListingResult =
	| (InstallForkSummary & { status: 'installed' })
	| (InstallForkSummary & {
			status: 'adaptation_required'
			failedChecks: Array<RepoCheckResult>
			crossScopeReferences: Array<CrossScopeReference>
	  })

type InstallCommunityListingInput = {
	env: Env
	baseUrl: string
	userId: OwnerId
	/** Org that should own the upstream follow. Defaults to `userId`. */
	followerOrgId?: OwnerId
	/** Acting person recorded on the follow. Defaults to `userId`. */
	creatorUserId?: string
	userEmail?: string | null
	expectedPackageScope: string
	listingId: string
	kodyId?: string
	/**
	 * The pinned commit the caller's trust/acknowledgement decision was made
	 * against; the fork rejects when an owner republish moved the listing to
	 * different content in the meantime.
	 */
	expectedPinnedCommit: string
	/**
	 * Defaults to `human`: one-click install is a person clicking a button.
	 * The MCP capability passes `agent` when it drives an install itself.
	 */
	actor?: CommunityForkActor | null
	waitUntil?: (promise: Promise<unknown>) => void
	reportProgress?: ReportInstallProgress
}

/**
 * One-click install: fork a community listing into the caller's scope and,
 * when the fork passes the same publish checks a repo session would run,
 * immediately publish it as a live saved package (which also schedules any
 * declared jobs). When checks fail — most commonly
 * because of cross-scope `kody:@` imports that cannot resolve in the
 * installer's account — the fork is kept as an inert source so an agent can
 * resume it through `repoOpenSession`, and no package is published.
 *
 * Callers are responsible for the acknowledgement gate: public listings
 * must only reach this after the user explicitly acknowledged the risk.
 *
 * Idempotent per (owner, listing): a repeat or concurrent install returns
 * the existing fork (`alreadyInstalled`) instead of creating a duplicate.
 */
export async function installCommunityListing(
	input: InstallCommunityListingInput,
): Promise<InstallCommunityListingResult> {
	return await runIdempotentCommunityFork<InstallCommunityListingResult>(
		{
			env: input.env,
			userId: input.userId,
			listingId: input.listingId,
			kodyId: input.kodyId,
			creatorUserId: input.creatorUserId,
			onWaiting: () =>
				reportInstallProgress(input.reportProgress, {
					progress: 1,
					total: 4,
					message:
						'A fork of this listing is already in progress; waiting for it instead of starting another.',
				}),
		},
		{
			existing: (fork) => existingInstallResult(input, fork),
			create: (hold) => createCommunityInstall(input, hold.claimId),
		},
	)
}

async function existingInstallResult(
	input: InstallCommunityListingInput,
	fork: CommunityForkRecord,
): Promise<InstallCommunityListingResult> {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: fork.forkedPackageId,
	})
	const packageScope = input.expectedPackageScope.replace(/^@/, '')
	const targetName = saved?.name ?? `@${packageScope}/${fork.targetKodyId}`
	const summary: InstallForkSummary = {
		forkId: fork.id,
		packageId: fork.forkedPackageId,
		sourceId: saved?.sourceId ?? fork.forkedSourceId,
		targetKodyId: fork.targetKodyId,
		targetName,
		originCommit: fork.originCommit,
		alreadyInstalled: true,
		message: buildAlreadyForkedMessage({
			targetName,
			forkedPackageId: fork.forkedPackageId,
			forkedSourceId: fork.forkedSourceId,
		}),
	}
	if (saved) return { ...summary, status: 'installed' }
	return {
		...summary,
		status: 'adaptation_required',
		failedChecks: [],
		crossScopeReferences: [],
	}
}

async function createCommunityInstall(
	input: InstallCommunityListingInput,
	claimId: string,
): Promise<InstallCommunityListingResult> {
	const installStartedAt = Date.now()
	await reportInstallProgress(input.reportProgress, {
		progress: 1,
		total: 4,
		message: 'Forking the listing into your account — source sync inbound…',
	})
	const prepareStartedAt = Date.now()
	const prepared = await prepareCommunityFork({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		followerOrgId: input.followerOrgId,
		creatorUserId: input.creatorUserId,
		expectedPackageScope: input.expectedPackageScope,
		listingId: input.listingId,
		kodyId: input.kodyId,
		expectedPinnedCommit: input.expectedPinnedCommit,
		actor: input.actor ?? 'human',
	})
	logInstallPhaseTiming({
		phase: 'install-prepare',
		durationMs: Date.now() - prepareStartedAt,
		listingId: input.listingId,
		packageId: prepared.packageId,
		filesCount: Object.keys(prepared.files).length,
	})

	// Community snapshots are always rooted at package.json (community publish
	// reads the owner package's source root), and forked entity sources are
	// created with the default manifest path and root — see ensureEntitySource
	// in persistPreparedCommunityFork.
	await reportInstallProgress(input.reportProgress, {
		progress: 2,
		total: 4,
		message:
			'Typechecking and bundling npm deps — overlapping Artifacts bootstrap…',
	})
	const overlapStartedAt = Date.now()
	const persistPromise = persistPreparedCommunityFork(prepared, { claimId })
	const checksPromise = runRepoChecks({
		workspace: createSnapshotFilesWorkspace(prepared.files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		expectedPackageScope: input.expectedPackageScope,
		requirePackageDocs: false,
		// Phase 1 stamp is authoring-publish only; forks stay adaptable (#3836).
		enforceCredentialStamp: false,
	})
	// Overlap is safe only if both sides finish before we return. Promise.all
	// would reject as soon as checks throw and abandon an in-flight persist,
	// leaving a fork the client never received (retry then collides).
	const [persistSettled, checksSettled] = await Promise.allSettled([
		persistPromise,
		checksPromise,
	])
	logInstallPhaseTiming({
		phase: 'install-persist-and-checks',
		durationMs: Date.now() - overlapStartedAt,
		listingId: input.listingId,
		packageId:
			persistSettled.status === 'fulfilled'
				? persistSettled.value.packageId
				: prepared.packageId,
		filesCount:
			persistSettled.status === 'fulfilled'
				? persistSettled.value.filesCount
				: Object.keys(prepared.files).length,
		status:
			persistSettled.status === 'rejected'
				? 'persist-failed'
				: checksSettled.status === 'rejected'
					? 'checks-threw'
					: checksSettled.value.ok
						? 'checks-ok'
						: 'checks-failed',
	})
	if (persistSettled.status === 'rejected') {
		throw persistSettled.reason
	}
	if (checksSettled.status === 'rejected') {
		throw checksSettled.reason
	}
	const fork = persistSettled.value
	// Overlapped checks used the prepared pin snapshot. When Artifacts dest
	// clone fallback syncs a newer dest-HEAD tree, re-check that tree before
	// projecting so install does not publish different contents than the fork.
	let checks = checksSettled.value
	if (fork.files !== prepared.files) {
		checks = await runRepoChecks({
			workspace: createSnapshotFilesWorkspace(fork.files),
			manifestPath: 'package.json',
			sourceRoot: '/',
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			expectedPackageScope: input.expectedPackageScope,
			requirePackageDocs: false,
			enforceCredentialStamp: false,
		})
	}
	const summary: InstallForkSummary = {
		forkId: fork.forkId,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
		targetKodyId: fork.targetKodyId,
		targetName: fork.targetName,
		originCommit: fork.originCommit,
	}
	if (!checks.ok) {
		await reportInstallProgress(input.reportProgress, {
			progress: 4,
			total: 4,
			message:
				'Checks need a human/agent touch — keeping the fork inert for adaptation.',
		})
		logInstallPhaseTiming({
			phase: 'install-total',
			durationMs: Date.now() - installStartedAt,
			listingId: input.listingId,
			packageId: fork.packageId,
			status: 'adaptation_required',
		})
		return {
			...summary,
			status: 'adaptation_required',
			failedChecks: checks.results.filter((check) => !check.ok),
			crossScopeReferences: fork.crossScopeReferences,
		}
	}

	await reportInstallProgress(input.reportProgress, {
		progress: 3,
		total: 4,
		message: 'Publishing and indexing — almost ready to invoke…',
	})
	const projectionStartedAt = Date.now()
	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		userEmail: input.userEmail,
		packageId: fork.packageId,
		sourceId: fork.sourceId,
		sourceFiles: fork.files,
		waitUntil: input.waitUntil,
		creatorUserId: input.creatorUserId ?? null,
		audit: optionalOrgAuditWriter(input.env, {
			userId: input.creatorUserId ?? null,
		}),
	})
	logInstallPhaseTiming({
		phase: 'install-projection',
		durationMs: Date.now() - projectionStartedAt,
		listingId: input.listingId,
		packageId: fork.packageId,
	})
	await reportInstallProgress(input.reportProgress, {
		progress: 4,
		total: 4,
		message: 'Installed. Your new package is live.',
	})
	logInstallPhaseTiming({
		phase: 'install-total',
		durationMs: Date.now() - installStartedAt,
		listingId: input.listingId,
		packageId: fork.packageId,
		status: 'installed',
	})
	return {
		...summary,
		status: 'installed',
	}
}

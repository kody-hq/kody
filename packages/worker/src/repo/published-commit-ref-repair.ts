import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listOwnerIdsPendingDeletion } from '#worker/account/owner-deletion-state.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	listArtifactServerRefs,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { runArtifactsGitWithRetry } from './artifacts-git-retry.ts'
import {
	confirmRemoteRefAtCommit,
	toFullBranchRef,
} from './confirm-remote-ref.ts'
import { getEntitySourceById } from './entity-sources.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'
import { finalizePublishedEntitySource } from './external-publish.ts'
import { loadIsomorphicGit } from './isomorphic-git-lazy.ts'
import { syncWorkspaceFiles } from './published-source-sync.ts'
import { listRepoSessionsBySource, updateRepoSession } from './repo-sessions.ts'
import { type EntitySourceRow } from './types.ts'

/**
 * Repair for package sources whose `published_commit` is not reachable from
 * any Artifacts ref (a publish advanced the pointer but the git ref update
 * never landed). The published source snapshot in KV is the surviving copy of
 * that tree. Apply commits that exact tree as a fast-forward child of the
 * current default-branch tip, confirms the ref, moves sessions that pointed at
 * the lost commit, and then advances `published_commit` through the normal
 * finalize path. Nothing is deleted; the prior records and refs are backed up
 * to KV first.
 */

export const publishedCommitRefRepairScanLimitDefault = 50
export const publishedCommitRefRepairScanLimitMax = 200
export const publishedCommitRefRepairApplyLimitMax = 3
const scanPageSize = 50
const maxScanPages = 20

const repairCommitAuthor = {
	name: 'Kody Source Repair',
	email: 'source-repair@local.invalid',
}

const repairBranch = 'kody-source-repair'

export type PublishedCommitRefRepairStatus =
	| 'consistent'
	| 'repairable'
	| 'unrecoverable'
	| 'repaired'
	| 'skipped_unpublished'
	| 'failed'

export type PublishedCommitRefRepairOutcome = {
	packageId: string
	ownerUserId: string
	sourceId: string
	publishedCommit: string | null
	outcome: PublishedCommitRefRepairStatus
	defaultBranch?: string
	defaultBranchHead?: string | null
	repairedCommit?: string
	movedSessionIds?: Array<string>
	backupKey?: string
	error?: string
}

export type PublishedCommitRefRepairResult = {
	dryRun: boolean
	scannedPackages: number
	consistent: number
	repairable: number
	unrecoverable: number
	repaired: number
	failed: number
	skippedUnpublished: number
	/**
	 * Packages whose owner is mid-deletion or deleted. Account deletion or the
	 * purge lane owns their storage, so they are counted and not inspected.
	 */
	skippedOwnerDeleting: number
	nextCursor: string | null
	outcomes: Array<PublishedCommitRefRepairOutcome>
}

type GitApi = Awaited<ReturnType<typeof loadIsomorphicGit>>

type RemoteInspection = {
	remote: string
	token: string
	defaultBranch: string
	defaultBranchHead: string | null
	refs: Array<{ ref: string; oid: string }>
	reachable: boolean
	workspace: ReturnType<typeof createEphemeralGitWorkspace> | null
	gitApi: GitApi | null
}

export function buildPublishedCommitRefRepairBackupKey(input: {
	sourceId: string
	publishedCommit: string
	at: string
}) {
	return `source-ref-repair-backup:v1:${input.sourceId}:${input.publishedCommit}:${input.at}`
}

/**
 * True when some advertised ref tip is the published commit. Most healthy
 * packages stop here; only the rest need a history walk.
 */
export function isPublishedCommitAdvertised(input: {
	refs: ReadonlyArray<{ ref: string; oid: string }>
	publishedCommit: string
}) {
	return input.refs.some(
		(entry) =>
			entry.ref.startsWith('refs/') && entry.oid === input.publishedCommit,
	)
}

async function inspectRemote(input: {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	scope: 'read' | 'write'
	keepWorkspace: boolean
}): Promise<RemoteInspection> {
	const repo = await resolveExistingArtifactSourceRepo(
		input.env,
		input.source.repo_id,
	)
	if (!repo) {
		throw new Error(`Artifact repo "${input.source.repo_id}" was not found.`)
	}
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const token = (
		await repo.createToken(input.scope, input.scope === 'write' ? 1800 : 300)
	).plaintext
	const defaultBranch = info.defaultBranch || 'main'
	const refs = (
		await listArtifactServerRefs({ remote: info.remote, token })
	).filter((entry): entry is { ref: string; oid: string } =>
		Boolean(entry.ref && entry.oid),
	)
	const defaultBranchHead =
		refs.find((entry) => entry.ref === toFullBranchRef(defaultBranch))?.oid ??
		null
	if (
		isPublishedCommitAdvertised({
			refs,
			publishedCommit: input.publishedCommit,
		}) &&
		!input.keepWorkspace
	) {
		return {
			remote: info.remote,
			token,
			defaultBranch,
			defaultBranchHead,
			refs,
			reachable: true,
			workspace: null,
			gitApi: null,
		}
	}
	// Walk every advertised branch's history: a published commit that is an
	// ancestor of some tip (for example HEAD ahead after a git-lane push) is
	// still durable.
	const gitApi = await loadIsomorphicGit()
	const { git, http } = gitApi
	const auth = buildArtifactsGitAuth({ token })
	const workspace = await runArtifactsGitWithRetry(async () => {
		const next = createEphemeralGitWorkspace()
		await git.init({ fs: next.fs, dir: next.dir })
		await git.addRemote({
			fs: next.fs,
			dir: next.dir,
			remote: 'origin',
			url: buildAuthenticatedArtifactsRemote({ remote: info.remote, token }),
		})
		await git.fetch({
			fs: next.fs,
			http,
			dir: next.dir,
			remote: 'origin',
			singleBranch: false,
			tags: false,
			onAuth: () => auth,
		})
		return next
	})
	let reachable = false
	try {
		await git.readCommit({
			fs: workspace.fs,
			dir: workspace.dir,
			oid: input.publishedCommit,
		})
		reachable = true
	} catch {
		reachable = false
	}
	return {
		remote: info.remote,
		token,
		defaultBranch,
		defaultBranchHead,
		refs,
		reachable,
		workspace,
		gitApi,
	}
}

/**
 * Apply the repair for one package source. Callers must have classified it
 * as `repairable` in the same run.
 */
async function applyRepair(input: {
	env: Env
	baseUrl: string
	source: EntitySourceRow
	publishedCommit: string
	inspection: RemoteInspection
	files: Record<string, string>
	rebuildArtifacts: (input: {
		sourceId: string
		userId: OwnerId
		publishedCommit: string
	}) => Promise<void>
}): Promise<{
	repairedCommit: string
	movedSessionIds: Array<string>
	backupKey: string
}> {
	const { inspection, source } = input
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) throw new Error('BUNDLE_ARTIFACTS_KV binding is required.')
	if (!inspection.workspace || !inspection.gitApi) {
		throw new Error('Repair needs a fetched workspace.')
	}
	if (!inspection.defaultBranchHead) {
		throw new Error(
			`Default branch "${inspection.defaultBranch}" has no tip to build on.`,
		)
	}
	const sessions = await listRepoSessionsBySource(input.env, {
		userId: source.user_id as OwnerId,
		sourceId: source.id,
	})
	const affectedSessions = sessions.filter(
		(session) =>
			session.base_commit === input.publishedCommit ||
			session.last_checkpoint_commit === input.publishedCommit,
	)
	// 1. Back up the current records and ref advertisement before any write.
	const at = new Date().toISOString()
	const backupKey = buildPublishedCommitRefRepairBackupKey({
		sourceId: source.id,
		publishedCommit: input.publishedCommit,
		at,
	})
	await kv.put(
		backupKey,
		JSON.stringify({
			version: 1,
			createdAt: at,
			source,
			defaultBranch: inspection.defaultBranch,
			defaultBranchHead: inspection.defaultBranchHead,
			refs: inspection.refs,
			sessions: affectedSessions,
			snapshotPublishedCommit: input.publishedCommit,
		}),
	)
	// 2. Commit the published snapshot tree on top of the current tip.
	const { git, http } = inspection.gitApi
	const workspace = inspection.workspace
	await git.branch({
		fs: workspace.fs,
		dir: workspace.dir,
		ref: repairBranch,
		object: inspection.defaultBranchHead,
		checkout: true,
		force: true,
	})
	await git.checkout({
		fs: workspace.fs,
		dir: workspace.dir,
		ref: repairBranch,
		force: true,
	})
	await syncWorkspaceFiles({
		git,
		filesystem: workspace.filesystem,
		fs: workspace.fs,
		dir: workspace.dir,
		files: input.files,
	})
	const repairedCommit = await git.commit({
		fs: workspace.fs,
		dir: workspace.dir,
		message: `Restore published source ${input.publishedCommit}\n\nThe published commit was not reachable from any ref. This commit restores\nits tree from the published source snapshot.\n`,
		author: repairCommitAuthor,
		committer: repairCommitAuthor,
	})
	// 3. Fast-forward the default branch (never force) and confirm it landed.
	const auth = buildArtifactsGitAuth({ token: inspection.token })
	await git.push({
		fs: workspace.fs,
		http,
		dir: workspace.dir,
		remote: 'origin',
		ref: repairBranch,
		remoteRef: inspection.defaultBranch,
		onAuth: () => auth,
	})
	await confirmRemoteRefAtCommit({
		remote: inspection.remote,
		token: inspection.token,
		ref: inspection.defaultBranch,
		commit: repairedCommit,
	})
	// 4. Move session branches and records that pointed at the lost commit.
	const movedSessionIds: Array<string> = []
	for (const session of affectedSessions) {
		if (session.session_branch) {
			await git.push({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: repairBranch,
				remoteRef: session.session_branch,
				force: true,
				onAuth: () => auth,
			})
			await confirmRemoteRefAtCommit({
				remote: inspection.remote,
				token: inspection.token,
				ref: session.session_branch,
				commit: repairedCommit,
			})
		}
		await updateRepoSession(input.env, {
			id: session.id,
			userId: session.user_id,
			...(session.base_commit === input.publishedCommit
				? { baseCommit: repairedCommit }
				: {}),
			...(session.last_checkpoint_commit === input.publishedCommit
				? { lastCheckpointCommit: repairedCommit }
				: {}),
		})
		movedSessionIds.push(session.id)
	}
	// 5. Advance published_commit only if nobody published meanwhile.
	const live = await getEntitySourceById(input.env.APP_DB, source.id)
	if (live?.published_commit !== input.publishedCommit) {
		throw new Error(
			`published_commit moved to "${live?.published_commit ?? 'none'}" during repair; the default branch now holds ${repairedCommit}. Re-run the scan.`,
		)
	}
	await finalizePublishedEntitySource({
		env: input.env,
		source: live,
		publishedCommit: repairedCommit,
		files: input.files,
		baseUrl: live.source_root,
		rebuildPackageArtifacts: false,
		// Repair re-points the already published tree; a package lock blocks
		// new content, not restoring what is already live.
		allowLockedPublish: true,
	})
	await input.rebuildArtifacts({
		sourceId: live.id,
		userId: live.user_id as OwnerId,
		publishedCommit: repairedCommit,
	})
	return { repairedCommit, movedSessionIds, backupKey }
}

async function listCandidatePackages(input: {
	env: Env
	afterId: string | null
	limit: number
	packageIds?: ReadonlySet<string>
}) {
	const packages: Array<SavedPackageRecord> = []
	let skippedOwnerDeleting = 0
	let cursor = input.afterId
	for (let pages = 1; ; pages += 1) {
		const page = await listSavedPackagesPage(input.env.APP_DB, {
			afterId: cursor,
			limit: scanPageSize,
		})
		if (page.length === 0) {
			return { packages, nextCursor: null, skippedOwnerDeleting }
		}
		const ownersPendingDeletion = await listOwnerIdsPendingDeletion(
			input.env.APP_DB,
			page
				.filter(
					(savedPackage) =>
						!input.packageIds || input.packageIds.has(savedPackage.id),
				)
				.map((savedPackage) => savedPackage.userId),
		)
		for (const savedPackage of page) {
			cursor = savedPackage.id
			if (input.packageIds && !input.packageIds.has(savedPackage.id)) continue
			if (ownersPendingDeletion.has(savedPackage.userId)) {
				skippedOwnerDeleting += 1
				continue
			}
			packages.push(savedPackage)
			if (packages.length >= input.limit) {
				return {
					packages,
					nextCursor: savedPackage.id,
					skippedOwnerDeleting,
				}
			}
		}
		if (page.length < scanPageSize) {
			return { packages, nextCursor: null, skippedOwnerDeleting }
		}
		if (pages >= maxScanPages) {
			return { packages, nextCursor: cursor, skippedOwnerDeleting }
		}
	}
}

export async function runPublishedCommitRefRepair(input: {
	env: Env
	baseUrl: string
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	rebuildArtifacts: (input: {
		sourceId: string
		userId: OwnerId
		publishedCommit: string
	}) => Promise<void>
}): Promise<PublishedCommitRefRepairResult> {
	const dryRun = input.dryRun !== false
	const packageIds = input.packageIds?.length
		? new Set(input.packageIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	if (!dryRun && !packageIds) {
		throw new Error(
			'Apply requires explicit packageIds. Run a dry-run scan first and pass the repairable package ids.',
		)
	}
	const limit = Math.max(
		1,
		Math.min(
			input.limit ?? publishedCommitRefRepairScanLimitDefault,
			dryRun
				? publishedCommitRefRepairScanLimitMax
				: publishedCommitRefRepairApplyLimitMax,
		),
	)
	const { packages, nextCursor, skippedOwnerDeleting } =
		await listCandidatePackages({
			env: input.env,
			afterId: input.afterId ?? null,
			limit,
			packageIds,
		})
	const result: PublishedCommitRefRepairResult = {
		dryRun,
		scannedPackages: packages.length,
		consistent: 0,
		repairable: 0,
		unrecoverable: 0,
		repaired: 0,
		failed: 0,
		skippedUnpublished: 0,
		skippedOwnerDeleting,
		nextCursor,
		outcomes: [],
	}
	for (const savedPackage of packages) {
		const base = {
			packageId: savedPackage.id,
			ownerUserId: savedPackage.userId,
			sourceId: savedPackage.sourceId,
		}
		let publishedCommit: string | null = null
		try {
			const source = await getEntitySourceById(
				input.env.APP_DB,
				savedPackage.sourceId,
			)
			publishedCommit = source?.published_commit?.trim() || null
			if (!source || source.entity_kind !== 'package' || !publishedCommit) {
				result.skippedUnpublished += 1
				result.outcomes.push({
					...base,
					publishedCommit,
					outcome: 'skipped_unpublished',
				})
				continue
			}
			const inspection = await inspectRemote({
				env: input.env,
				source,
				publishedCommit,
				scope: dryRun ? 'read' : 'write',
				keepWorkspace: !dryRun,
			})
			const detail = {
				defaultBranch: inspection.defaultBranch,
				defaultBranchHead: inspection.defaultBranchHead,
			}
			if (inspection.reachable) {
				result.consistent += 1
				// Healthy packages are counted, not listed, to keep pages small.
				if (packageIds) {
					result.outcomes.push({
						...base,
						...detail,
						publishedCommit,
						outcome: 'consistent',
					})
				}
				continue
			}
			const snapshot = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: source.id,
				publishedCommit,
			})
			const files = snapshot?.files
			if (
				!files ||
				typeof files[source.manifest_path] !== 'string' ||
				Object.keys(files).length === 0
			) {
				result.unrecoverable += 1
				result.outcomes.push({
					...base,
					...detail,
					publishedCommit,
					outcome: 'unrecoverable',
					error:
						'No published source snapshot exists for the unreachable published commit.',
				})
				continue
			}
			if (dryRun) {
				result.repairable += 1
				result.outcomes.push({
					...base,
					...detail,
					publishedCommit,
					outcome: 'repairable',
				})
				continue
			}
			const repaired = await applyRepair({
				env: input.env,
				baseUrl: input.baseUrl,
				source,
				publishedCommit,
				inspection,
				files,
				rebuildArtifacts: input.rebuildArtifacts,
			})
			result.repaired += 1
			result.outcomes.push({
				...base,
				...detail,
				publishedCommit,
				outcome: 'repaired',
				...repaired,
			})
		} catch (error) {
			result.failed += 1
			result.outcomes.push({
				...base,
				publishedCommit,
				outcome: 'failed',
				error: getErrorMessage(error),
			})
		}
	}
	return result
}

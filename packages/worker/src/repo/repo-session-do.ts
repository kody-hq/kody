import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isUserCodeError } from '#worker/user-code-error.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	Workspace,
	WorkspaceFileSystem,
	createWorkspaceStateBackend,
} from '@cloudflare/shell'
import { applyPatch, formatPatch, parsePatch } from 'diff'
import {
	splitUnifiedDiffSections,
	resolveUnifiedDiffFileNames,
	stripUnifiedDiffPath,
} from './unified-diff-paths.ts'
import {
	deleteRepoSession,
	getRepoSessionById,
	insertRepoSession,
	updateRepoSession,
} from './repo-sessions.ts'
import {
	type ArtifactBootstrapAccess,
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	listArtifactServerRefs,
	resolveArtifactSourceHead,
	resolveExistingArtifactSourceRepo,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { bytesToSnapshotString } from '#universal/package-file-media.ts'
import {
	getEntitySourceById,
	markEntitySourcePendingExternalReconcile,
	updateEntitySource,
} from './entity-sources.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	createPackagePublishLockedError,
	loadLockedSavedPackage,
} from '#worker/package-registry/package-publish-lock.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	collectPublishedPackageArtifactTargets,
	isPublishedPackageArtifactBuiltForCommit,
	persistPublishedPackageArtifactTarget,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { type PreparedKodyGraphCache } from '#worker/package-runtime/module-graph.ts'
import {
	hasPublishedRuntimeArtifacts,
	loadPublishedSourceManifestSnapshot,
	loadPublishedSourceSnapshot,
	publishedSourceSnapshotFilesMatch,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { planRepoSessionContentEdits } from './plan-repo-session-content-edits.ts'
import { searchRepoWorkspace } from './repo-session-search.ts'
import { repoSessionRpc as createRepoSessionRpc } from './repo-session-rpc.ts'
import {
	resolveRepoWorkspacePath,
	toExternalRepoPath,
	toRepoSessionInfoResult,
	toRepoSessionTreeResult,
} from './repo-session-tree.ts'
import {
	runPackageTypecheckLanguageService,
	runRepoChecks,
	runRepoSourceWalkChecks,
	formatFailedRepoCheckMessages,
	validatePackageBundles,
} from './checks.ts'
import { RepoChecksFailedError } from './repo-checks-failed-error.ts'
import { runAuthoringPublishChecks } from './authoring-publish-checks.ts'
import { credentialPatternNoticeForFiles } from './credential-pattern-check.ts'
import { loadSecretMountCompatNotice } from '#worker/package-runtime/secret-mount-compat.ts'
import { loadCredentialAllowedPackagesPublishWarningNotice } from '#worker/credentials/credential-allowed-packages-publish-warning.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	pausedSessionMovedMessage,
	requireCredentialNeedsApproval,
} from '#worker/credentials/credential-needs-approval.ts'
import {
	isolatedArtifactRebuildStagingKeyBelongsToUser,
	isolatedArtifactRebuildStagingKeyForUser,
	isolatedArtifactRebuildStagingTtlSeconds,
	type IsolatedArtifactRebuildOutcome,
	type IsolatedArtifactRebuildRequest,
	type IsolatedArtifactRebuildTargetResult,
} from './isolated-artifact-rebuild.ts'
import {
	isolatedCheckStagingKeyBelongsToUser,
	type IsolatedCheckPhaseOutcome,
	type IsolatedCheckPhaseRequest,
} from './isolated-check-phases.ts'
import {
	type EntitySourceRow,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoExternalPublishResult,
	type RepoExternalRefCheckResult,
	type RepoSourceBootstrapResult,
	type RepoSessionApplyEditsResult,
	type RepoSessionEdit,
	type RepoSessionCheckRun,
	type RepoSessionCheckStatus,
	type RepoSessionDiscardResult,
	type RepoSessionPublishResult,
	type RepoSessionRebaseResult,
	type RepoSessionRow,
	type RepoSessionSearchResult,
	type RepoSessionTreeResult,
} from './types.ts'
import {
	finalizePublishedEntitySource,
	publishFromExternalRef as publishExternalRefSource,
} from './external-publish.ts'
import {
	buildWorkspaceSqliteTooBigCallerMessage,
	cloneExternalPublishWorkspace,
	externalPublishWorkspaceDir,
	isWorkspaceSqliteTooBigMessage,
} from './external-publish-clone.ts'
import { classifyExternalPublishCloneError } from './requested-commit-error.ts'
import {
	attachPublishPhaseTimings,
	timePublishExternalPushPhase,
	type PublishPhaseTimings,
} from './publish-phase-timing.ts'
import {
	buildRepoSessionWorkspaceName,
	measureRepoSessionWorkspaceBlobBytes,
	purgeRepoSessionWorkspaceBlobs,
} from './repo-session-blobs.ts'
import {
	buildRepoApplyPatchParseCallerMessage,
	buildRepoSessionNotFoundForUserMessage,
	buildRepoSessionNotFoundMessage,
	isGitPushNotFastForwardError,
} from './repo-session-caller-error.ts'
import {
	assertPackagePrivateVisibilityChangeAllowed,
	assertPackageSourceOverwriteAllowed,
	assertPublishedPackageSourceRepoHead,
	buildSourceRecoveryProblemMessage,
	loadPriorPackageManifestContent,
} from './source-safety-policy.ts'
import {
	attachPublishGitNoteBestEffort,
	buildPublishGitNote,
	type KodyPublishGitNoteChecks,
} from './publish-git-notes.ts'
import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'
import { loadIsomorphicGit, type IsomorphicGit } from './isomorphic-git-lazy.ts'
import {
	isTransientArtifactsGitError,
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import {
	buildRepoDiffTooLargeMessage,
	buildRepoLargeFileMessage,
	isRepoDiffTooLargeMessage,
	maxRepoSourceFileBytes,
	maxRepoSourceFileDiffLines,
	measureRepoSourceFileBytes,
	measureRepoSourceFileLines,
} from './large-file-policy.ts'
import {
	deleteStorageBucketInventory,
	maybeRefreshStorageBucketEstimate,
	registerStorageBucketAndWait,
	repoSessionStorageBucketId,
	storageBucketInventoryExists,
} from '#worker/storage-buckets/service.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

const repoSessionWorkspacePrefix = '/session'
const lastCheckStatusStorageKey = 'repo-session:last-check-status'
const cachedSessionStateStorageKeyPrefix = 'repo-session:state:'
const defaultSessionBranch = 'main'
const publishedSessionRetentionMs = 14 * 24 * 60 * 60 * 1000
/**
 * Appended to successful `publishSession` messages so agents know the
 * workspace scratch no longer counts toward `storage_bytes`. Catalog rows
 * stay for {@link publishedSessionRetentionMs} (or until discard).
 */
export const publishedSessionScratchReleasedNotice =
	'Session scratch no longer counts toward storage; the catalog row is retained for 14 days (repoDiscardSession removes it sooner).'
const sessionCommitAuthor = {
	name: 'Kody Repo Session',
	email: 'repo-session@local.invalid',
}

type CachedRepoSessionState = {
	sessionRow: RepoSessionRow
	source: EntitySourceRow
}

type RawGitPushInput = Parameters<IsomorphicGit['git']['push']>[0]
type CreateGit = typeof import('@cloudflare/shell/git').createGit

function nowIso() {
	return new Date().toISOString()
}

function getCachedSessionStateStorageKey(sessionId: string) {
	return `${cachedSessionStateStorageKeyPrefix}${sessionId}`
}

// D1 read replicas can lag briefly behind the primary; when we know a row was
// just inserted (for example, openSession persisted a fresh repo session before
// returning to the worker), an immediate read from a different request handler
// may still miss it. A short retry with backoff papers over that lag without
// resorting to global throttling.
const repoLookupRetryDelaysMs = [50, 100, 200, 400] as const

export async function readWithRetry<T>(
	read: () => Promise<T | null>,
	delaysMs: ReadonlyArray<number> = repoLookupRetryDelaysMs,
): Promise<T | null> {
	let result = await read()
	if (result != null) return result
	for (const delayMs of delaysMs) {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		result = await read()
		if (result != null) return result
	}
	return null
}

async function readRepoSessionWithRetry(
	env: Env,
	input: { userId: OwnerId; sessionId: string },
) {
	return readWithRetry(() => getRepoSessionById(env, input))
}

async function readEntitySourceWithRetry(db: D1Database, sourceId: string) {
	return readWithRetry(() => getEntitySourceById(db, sourceId))
}

function compactArtifactsRepoSuffix(value: string) {
	const compact = value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
	return compact.length > 0 ? compact : 'session'
}

function buildSessionBranchName(sessionId: string) {
	const readable = compactArtifactsRepoSuffix(sessionId).slice(0, 32)
	const unique = crypto.randomUUID().replaceAll('-', '')
	return `sessions/${readable}-${unique}`
}

function isSessionBranchRef(ref: string) {
	const branch = ref.startsWith('refs/heads/')
		? ref.slice('refs/heads/'.length)
		: ref
	return branch.startsWith('sessions/')
}

function buildPublishedSessionExpiresAt(now: Date = new Date()) {
	return new Date(now.valueOf() + publishedSessionRetentionMs).toISOString()
}

function buildPendingExternalReconcile(
	db: D1Database,
	source: EntitySourceRow,
) {
	if (source.entity_kind !== 'package') return undefined
	return { db, source }
}

async function resolveLiveSourceHeadCommit(env: Env, source: EntitySourceRow) {
	const head = await resolveArtifactSourceHead(env, source.repo_id)
	return head.commit
}

async function ensureArtifactRepoRemote(input: {
	repo: {
		info: () => Promise<{ remote: string } | null>
		createToken: (
			scope?: 'write' | 'read',
			ttl?: number,
		) => Promise<{
			plaintext: string
		}>
	}
	scope?: 'write' | 'read'
	pendingReconcile?: {
		db: D1Database
		source: Pick<EntitySourceRow, 'id' | 'user_id'>
	}
}) {
	const info = await input.repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const tokenTtlSeconds = 3600
	const scope = input.scope ?? 'write'
	const token = await input.repo.createToken(scope, tokenTtlSeconds)
	if (scope === 'write' && input.pendingReconcile) {
		await markEntitySourcePendingExternalReconcile(input.pendingReconcile.db, {
			id: input.pendingReconcile.source.id,
			userId: input.pendingReconcile.source.user_id,
			tokenExpiresAt: new Date(
				Date.now() + tokenTtlSeconds * 1000,
			).toISOString(),
		})
	}
	return {
		remote: info.remote,
		token: token.plaintext,
	}
}

function buildGitCloneAuth(input: { remote: string; token: string }) {
	return {
		url: input.remote,
		...buildArtifactsGitAuth({ token: input.token }),
	}
}

class RepoSessionBase extends DurableObject<Env> {
	readonly workspace = new Workspace({
		sql: this.ctx.storage.sql,
		name: () => buildRepoSessionWorkspaceName(this.ctx.id.toString()),
		r2: this.env.REPO_SESSION_BLOBS,
	})

	readonly fileSystem = new WorkspaceFileSystem(this.workspace)

	readonly rawGitFileSystem = createIsomorphicGitFs(this.fileSystem)

	readonly state = createWorkspaceStateBackend(this.workspace)

	private gitApi: ReturnType<CreateGit> | null = null

	private async ensureGit() {
		if (!this.gitApi) {
			const { createGit: createShellGit } = await loadIsomorphicGit()
			this.gitApi = createShellGit(this.fileSystem, repoSessionWorkspacePrefix)
		}
		return this.gitApi
	}

	private initializedSessionId: string | null = null

	/**
	 * Clone an Artifacts remote with brief retries for transient HTTP 5xx /
	 * 429 and isomorphic-git packfile corruption (KODY-CLOUDFLARE-55). Retries
	 * always reset the DO workspace so a partial unpack cannot poison the next
	 * attempt. Callers that already expect a clean tree (openSession / publish)
	 * pass `resetBeforeFirstAttempt`.
	 */
	private async cloneArtifactsRepoWithRetry(input: {
		remote: string
		token: string
		branch?: string | null
		resetBeforeFirstAttempt?: boolean
	}) {
		let attempt = 0
		try {
			await runArtifactsGitWithRetry(async () => {
				if (attempt > 0 || input.resetBeforeFirstAttempt) {
					await this.resetWorkspace()
				}
				attempt += 1
				await this.workspace.mkdir(repoSessionWorkspacePrefix, {
					recursive: true,
				})
				await (
					await this.ensureGit()
				).clone({
					dir: repoSessionWorkspacePrefix,
					...(input.branch
						? {
								branch: input.branch,
								singleBranch: true,
							}
						: {}),
					...buildGitCloneAuth({
						remote: input.remote,
						token: input.token,
					}),
				})
			})
		} catch (error) {
			// Only wrap Artifacts-transient signatures (HTTP 5xx / packfile
			// corruption). Bare Cloudflare opaque internals must stay unwrapped
			// so repoOpenSession can still match and retry with a fresh
			// session id (KODY-CLOUDFLARE-4H).
			if (isTransientArtifactsGitError(error)) {
				throw wrapArtifactsGitHttpError({
					operation: 'git clone',
					remote: input.remote,
					error,
				})
			}
			const message = getErrorMessage(error)
			if (isWorkspaceSqliteTooBigMessage(message)) {
				throw new Error(
					buildWorkspaceSqliteTooBigCallerMessage('Repo session clone'),
					{ cause: error },
				)
			}
			throw error
		}
	}

	// In-memory cache for the active DO instance. This serves as the primary
	// fallback for follow-up RPC calls on the same sessionId so that even the
	// shortest replication lag between D1 writes and reads does not surface as
	// a spurious "Repo session was not found" error during scheduled runs.
	private readonly inMemorySessionState = new Map<
		string,
		CachedRepoSessionState
	>()

	async getEstimatedBytes(): Promise<{ estimatedBytes: number }> {
		return { estimatedBytes: await this.readEstimatedWorkspaceBytes() }
	}

	private async readEstimatedWorkspaceBytes(): Promise<number> {
		const r2Bytes = await measureRepoSessionWorkspaceBlobBytes({
			blobs: this.env.REPO_SESSION_BLOBS,
			durableObjectId: this.ctx.id.toString(),
		})
		return this.ctx.storage.sql.databaseSize + r2Bytes
	}

	private refreshStoredEstimate(sessionId: string, userId: OwnerId): void {
		maybeRefreshStorageBucketEstimate({
			env: this.env,
			userId,
			storageId: repoSessionStorageBucketId(sessionId),
			readEstimatedBytes: async () => this.readEstimatedWorkspaceBytes(),
			waitUntil: (promise) => this.ctx.waitUntil(promise),
		})
	}

	private async purgeWorkspaceBlobs(): Promise<void> {
		await purgeRepoSessionWorkspaceBlobs({
			blobs: this.env.REPO_SESSION_BLOBS,
			durableObjectId: this.ctx.id.toString(),
		})
	}

	private async deleteStorageInventory(
		sessionId: string,
		userId: OwnerId,
	): Promise<void> {
		await deleteStorageBucketInventory({
			db: this.env.APP_DB,
			userId,
			storageId: repoSessionStorageBucketId(sessionId),
		})
	}

	/**
	 * After a successful publish, durable source lives in Artifacts + the
	 * published snapshot. Drop workspace scratch and its storage-bucket
	 * inventory so leftover session bytes cannot push the owner over their
	 * plan storage limit. Keeps the catalog row (`published` + expires_at).
	 * Idempotent and never throws: publish already committed; cleanup failure
	 * must not fail the capability or block getSessionInfo heal. Cron expiry
	 * still purges leftovers.
	 */
	private async releasePublishedSessionScratch(
		sessionId: string,
		userId: OwnerId,
	): Promise<void> {
		try {
			await this.clearCachedSessionState(sessionId)
			await this.resetWorkspace().catch(() => {
				// Best-effort; R2 prefix purge below is the safety net.
			})
			await this.purgeWorkspaceBlobs()
			await this.deleteStorageInventory(sessionId, userId)
			this.initializedSessionId = null
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'published session scratch release failed',
					sessionId,
					error: getErrorMessage(error),
				}),
			)
		}
	}

	private async readCachedSessionState(
		sessionId: string,
	): Promise<CachedRepoSessionState | null> {
		const inMemory = this.inMemorySessionState.get(sessionId)
		if (inMemory) {
			return inMemory
		}
		const persisted =
			(await this.ctx.storage.get<CachedRepoSessionState | null>(
				getCachedSessionStateStorageKey(sessionId),
			)) ?? null
		if (persisted) {
			this.inMemorySessionState.set(sessionId, persisted)
		}
		return persisted
	}

	private async writeCachedSessionState(
		state: CachedRepoSessionState,
	): Promise<void> {
		this.inMemorySessionState.set(state.sessionRow.id, state)
		await this.ctx.storage.put(
			getCachedSessionStateStorageKey(state.sessionRow.id),
			state,
		)
	}

	private async clearCachedSessionState(sessionId: string): Promise<void> {
		this.inMemorySessionState.delete(sessionId)
		await this.ctx.storage.put(getCachedSessionStateStorageKey(sessionId), null)
	}

	private async touchRepoSession(sessionRow: RepoSessionRow) {
		await updateRepoSession(this.env, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
		})
	}

	private async getSessionState(
		sessionId: string,
		userId: OwnerId,
		options: {
			allowedStatuses?: ReadonlyArray<RepoSessionRow['status']>
			/**
			 * When false, skip artifact remote mint + workspace clone. Use for
			 * catalog-only reads (getSessionInfo) so inspecting a published
			 * session cannot rehydrate scratch that publish already released.
			 */
			initialize?: boolean
		} = {},
	) {
		const cachedState = await this.readCachedSessionState(sessionId)
		// Prefer fresh catalog reads so correctness-sensitive flows like
		// rebaseSession and publishSession always observe the latest
		// base_commit and published_commit. The cache is only a fallback for
		// when a catalog read genuinely cannot see a row immediately after
		// openSession inserted it; this keeps scheduled jobs from throwing
		// "Repo session was not found" while still letting concurrent
		// mutations through updateRepoSession / updateEntitySource drive
		// rebase and publish decisions.
		const sessionRow =
			(await readRepoSessionWithRetry(this.env, { userId, sessionId })) ??
			cachedState?.sessionRow ??
			null
		if (!sessionRow) {
			throw new Error(buildRepoSessionNotFoundMessage(sessionId))
		}
		if (sessionRow.user_id !== userId) {
			throw new Error(buildRepoSessionNotFoundForUserMessage(sessionId))
		}
		const allowedStatuses = options.allowedStatuses ?? ['active']
		if (!allowedStatuses.includes(sessionRow.status)) {
			throw new Error(
				`Repo session "${sessionId}" is ${sessionRow.status}; open a new session before continuing.`,
			)
		}
		const source =
			(await readEntitySourceWithRetry(
				this.env.APP_DB,
				sessionRow.source_id,
			)) ??
			(cachedState?.source?.id === sessionRow.source_id
				? cachedState.source
				: null)
		if (!source) {
			throw new Error(`Source "${sessionRow.source_id}" was not found.`)
		}
		await this.writeCachedSessionState({ sessionRow, source })
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const access = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
			pendingReconcile: buildPendingExternalReconcile(this.env.APP_DB, source),
		})
		// Catalog-only reads (getSessionInfo) skip clone so inspecting a
		// published session cannot rehydrate scratch publish already released.
		if (options.initialize !== false) {
			await this.initialize({
				sessionId: sessionRow.id,
				repoRemote: access.remote,
				repoToken: access.token,
				sessionBranch: sessionRow.session_branch,
			})
		}
		return {
			sessionRow,
			source,
			sourceRepo,
			sessionAccess: access,
		}
	}

	private async ensureRemote(input: { name: string; url: string }) {
		const existing = await (
			await this.ensureGit()
		).remote({
			dir: repoSessionWorkspacePrefix,
			list: true,
		})
		const remotes = Array.isArray(existing) ? existing : []
		const current = remotes.find((remote) => remote.remote === input.name)
		if (current?.url === input.url) {
			return
		}
		if (current) {
			await (
				await this.ensureGit()
			).remote({
				dir: repoSessionWorkspacePrefix,
				remove: input.name,
			})
		}
		await (
			await this.ensureGit()
		).remote({
			dir: repoSessionWorkspacePrefix,
			add: {
				name: input.name,
				url: input.url,
			},
		})
	}

	private async resetWorkspace() {
		const gitConfigPath = `${repoSessionWorkspacePrefix}/.git/config`
		for (let attempt = 0; attempt < 2; attempt += 1) {
			await this.workspace.rm(repoSessionWorkspacePrefix, {
				force: true,
				recursive: true,
			})
			const [workspaceExists, gitConfigExists] = await Promise.all([
				this.workspace.exists(repoSessionWorkspacePrefix),
				this.workspace.exists(gitConfigPath),
			])
			if (!workspaceExists && !gitConfigExists) {
				this.initializedSessionId = null
				return
			}
		}
		throw new Error(
			`Failed to remove repo session workspace "${repoSessionWorkspacePrefix}" cleanly.`,
		)
	}

	private async hasExpectedOriginRemote(expectedUrl: string) {
		try {
			const remotes = await (
				await this.ensureGit()
			).remote({
				dir: repoSessionWorkspacePrefix,
				list: true,
			})
			if (!Array.isArray(remotes)) {
				return false
			}
			return remotes.some(
				(remote) => remote.remote === 'origin' && remote.url === expectedUrl,
			)
		} catch {
			return false
		}
	}

	private async readManifestFromWorkspace(
		manifestPath: string,
		expectedPackageScope?: string,
	) {
		const manifestContent = await this.workspace.readFile(
			resolveRepoWorkspacePath(manifestPath, repoSessionWorkspacePrefix),
		)
		if (manifestContent == null) {
			throw new Error(`Manifest "${manifestPath}" was not found.`)
		}
		return parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath,
			expectedPackageScope,
		})
	}

	private async getHeadCommit() {
		const log = await (
			await this.ensureGit()
		).log({
			dir: repoSessionWorkspacePrefix,
			depth: 1,
		})
		return log[0]?.oid ?? null
	}

	private async commitIfDirty(
		message: string,
		options?: { replaceHistory?: boolean },
	) {
		const replaceHistory = options?.replaceHistory === true
		const statusEntries = await (
			await this.ensureGit()
		).status({
			dir: repoSessionWorkspacePrefix,
		})
		const hasChanges = statusEntries.some(
			(entry) => entry.status !== 'unmodified',
		)
		if (!hasChanges && !replaceHistory) {
			return this.getHeadCommit()
		}
		await (
			await this.ensureGit()
		).add({
			dir: repoSessionWorkspacePrefix,
			filepath: '.',
		})
		if (replaceHistory) {
			const { git } = await loadIsomorphicGit()
			return await git.commit({
				fs: this.rawGitFileSystem,
				dir: repoSessionWorkspacePrefix,
				message,
				author: sessionCommitAuthor,
				parent: [],
			})
		}
		const commit = await (
			await this.ensureGit()
		).commit({
			dir: repoSessionWorkspacePrefix,
			message,
			author: sessionCommitAuthor,
		})
		return commit.oid
	}

	private async pushBranchToRemoteRef(input: {
		branch: string
		remoteRef: string
		token: string
		force?: boolean
	}) {
		const auth = buildArtifactsGitAuth({ token: input.token })
		const { git, http } = await loadIsomorphicGit()
		return git.push({
			fs: this.rawGitFileSystem as RawGitPushInput['fs'],
			http,
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: input.branch,
			remoteRef: input.remoteRef,
			...(input.force === true ? { force: true } : {}),
			onAuth() {
				return auth
			},
		})
	}

	private buildPublishBaseMovedResult(input: {
		sessionId: string
		sessionBaseCommit: string
		currentPublishedCommit: string | null
	}): Extract<RepoSessionPublishResult, { status: 'base_moved' }> {
		return {
			status: 'base_moved',
			sessionId: input.sessionId,
			publishedCommit: null,
			sessionBaseCommit: input.sessionBaseCommit,
			currentPublishedCommit: input.currentPublishedCommit,
			repairHint: 'repoRebaseSession',
			message:
				'The source repo rejected a non-fast-forward publish. Rebase the session before publishing.',
		}
	}

	private async deleteRemoteBranch(input: { branch: string; token: string }) {
		const auth = buildArtifactsGitAuth({ token: input.token })
		const { git, http } = await loadIsomorphicGit()
		return git.push({
			fs: this.rawGitFileSystem as RawGitPushInput['fs'],
			http,
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: input.branch,
			delete: true,
			onAuth() {
				return auth
			},
		})
	}

	/**
	 * After a confirmed history-replace promote, drop every advertised
	 * `sessions/*` ref on this source repo so leftover source-sync (and other
	 * session) branches cannot keep prior objects reachable. Concurrent
	 * sessions are already stranded across the orphan root. Restorable KV
	 * backups are untouched.
	 */
	private async deleteAdvertisedSessionBranches(input: {
		sessionBranch: string
		remote: string
		token: string
	}) {
		const branches = new Set<string>([input.sessionBranch])
		try {
			const refs = await listArtifactServerRefs({
				remote: input.remote,
				token: input.token,
				prefix: 'refs/heads/sessions/',
			})
			for (const entry of refs) {
				if (!isSessionBranchRef(entry.ref)) continue
				const branch = entry.ref.startsWith('refs/heads/')
					? entry.ref.slice('refs/heads/'.length)
					: entry.ref
				branches.add(branch)
			}
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'history-replace session ref list failed',
					sessionBranch: input.sessionBranch,
					error: getErrorMessage(error),
				}),
			)
		}
		for (const branch of branches) {
			try {
				await this.deleteRemoteBranch({
					branch,
					token: input.token,
				})
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'history-replace session branch delete failed',
						branch,
						error: getErrorMessage(error),
					}),
				)
			}
		}
	}

	private async listWorkspaceFileEntries(
		root = repoSessionWorkspacePrefix,
	): Promise<Array<{ path: string }>> {
		const normalizedRoot = root.replace(/\/+$/, '')
		const entries = await this.workspace.glob(`${normalizedRoot}/**/*`)
		return entries
			.filter((entry) => entry.type === 'file')
			.filter((entry) => !entry.path.includes('/.git/'))
			.sort((left, right) => left.path.localeCompare(right.path))
			.map((entry) => ({ path: entry.path }))
	}

	private async collectWorkspaceFiles(
		root = repoSessionWorkspacePrefix,
	): Promise<Record<string, string>> {
		const snapshot = await this.collectWorkspacePublishSnapshot(root)
		return snapshot.files
	}

	/**
	 * One workspace walk that yields both the relative-path file map and the
	 * tree hash used for checks_outdated. Publish reuses this instead of
	 * globbing and re-reading every file three times.
	 */
	private async collectWorkspacePublishSnapshot(
		root = repoSessionWorkspacePrefix,
	): Promise<{ files: Record<string, string>; treeHash: string }> {
		const entries = await this.listWorkspaceFileEntries(root)
		const rootPrefix = `${root.replace(/\/+$/, '')}/`
		const files: Record<string, string> = {}
		const chunks: Array<string> = []
		for (const entry of entries) {
			// Raw bytes — UTF-8 `readFile` replaces invalid sequences with
			// U+FFFD (PNG `0x89` → `0xFD`), which then poisons `/_assets`.
			const bytes = await this.workspace.readFileBytes(entry.path)
			// Treat an unreadable file as a hard failure so the caller aborts
			// and triggers rollback instead of persisting a KV snapshot that
			// is silently missing files. A null read here usually means the
			// file was unlinked between glob and read, which means the tree
			// we are about to publish is not the tree we scanned.
			if (bytes == null) {
				throw new Error(
					`Failed to read repo session file "${entry.path}" while collecting workspace snapshot.`,
				)
			}
			const relativePath = entry.path.startsWith(rootPrefix)
				? entry.path.slice(rootPrefix.length)
				: entry.path
			const content = bytesToSnapshotString(bytes, relativePath)
			files[relativePath] = content
			chunks.push(`${entry.path}\n${content}\n`)
		}
		const data = new TextEncoder().encode(chunks.join(''))
		const digest = await crypto.subtle.digest('SHA-256', data)
		const treeHash = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
		return { files, treeHash }
	}

	private async computeTreeHash(root = repoSessionWorkspacePrefix) {
		const entries = await this.listWorkspaceFileEntries(root)
		const rootPrefix = `${root.replace(/\/+$/, '')}/`
		const chunks: Array<string> = []
		for (const entry of entries) {
			const bytes = await this.workspace.readFileBytes(entry.path)
			const relativePath = entry.path.startsWith(rootPrefix)
				? entry.path.slice(rootPrefix.length)
				: entry.path
			const content =
				bytes == null ? '' : bytesToSnapshotString(bytes, relativePath)
			chunks.push(`${entry.path}\n${content}\n`)
		}
		const data = new TextEncoder().encode(chunks.join(''))
		const digest = await crypto.subtle.digest('SHA-256', data)
		return [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
	}

	private async writeCheckStatus(status: RepoSessionCheckStatus) {
		await this.ctx.storage.put(lastCheckStatusStorageKey, status)
	}

	private async readCheckStatus(): Promise<RepoSessionCheckStatus> {
		return (
			(await this.ctx.storage.get<RepoSessionCheckStatus>(
				lastCheckStatusStorageKey,
			)) ?? {
				runId: null,
				treeHash: null,
				checkedAt: null,
				ok: null,
				results: null,
			}
		)
	}

	private buildPublishGitNoteChecks(
		checkStatus: RepoSessionCheckStatus,
	): KodyPublishGitNoteChecks | null {
		if (!checkStatus.runId || checkStatus.ok == null) {
			return null
		}
		return {
			runId: checkStatus.runId,
			treeHash: checkStatus.treeHash,
			checkedAt: checkStatus.checkedAt,
			ok: checkStatus.ok,
			results: (checkStatus.results ?? []).map((entry) => ({
				kind: entry.kind,
				ok: entry.ok,
				message: entry.message,
			})),
		}
	}

	private async attachSourcePublishGitNote(input: {
		source: EntitySourceRow
		commitOid: string
		remote: string
		token: string
		remoteName?: string
		publishedBy: 'repo_session' | 'source_bootstrap' | 'external_push'
		sessionId?: string | null
		conversationId?: string | null
		baseCommit?: string | null
		previousPublishedCommit?: string | null
		checks?: KodyPublishGitNoteChecks | null
		scope: string
	}) {
		await attachPublishGitNoteBestEffort({
			filesystem: this.fileSystem,
			dir: repoSessionWorkspacePrefix,
			commitOid: input.commitOid,
			remote: input.remote,
			token: input.token,
			remoteName: input.remoteName,
			note: buildPublishGitNote({
				publishedBy: input.publishedBy,
				source: input.source,
				commit: input.commitOid,
				sessionId: input.sessionId,
				conversationId: input.conversationId,
				baseCommit: input.baseCommit,
				previousPublishedCommit: input.previousPublishedCommit,
				checks: input.checks,
			}),
			scope: input.scope,
		})
	}

	private async resolvePublishSource(input: {
		sessionId?: string
		sourceId?: string
		userId: OwnerId
	}) {
		if (input.sessionId) {
			// Catalog first without clone. Published sessions must not
			// rehydrate scratch after publish released storage inventory;
			// active sessions still need the workspace for pre-publish
			// manifest / rebuild fallbacks when no published snapshot exists.
			const { source, sessionRow } = await this.getSessionState(
				input.sessionId,
				input.userId,
				{
					allowedStatuses: ['active', 'published'],
					initialize: false,
				},
			)
			if (sessionRow.status === 'active') {
				await this.getSessionState(input.sessionId, input.userId, {
					allowedStatuses: ['active'],
				})
			}
			return source
		}
		if (!input.sourceId) {
			throw new Error('A sessionId or sourceId is required.')
		}
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source || source.user_id !== input.userId) {
			throw new Error('Repo source was not found for this user.')
		}
		return source
	}

	private async listPackageArtifactTargetsForSource(source: EntitySourceRow) {
		if (source.entity_kind !== 'package') return []
		const manifest = await this.readPackageManifestForPublishedArtifacts(source)
		return collectPublishedPackageArtifactTargets(
			manifest as Parameters<typeof collectPublishedPackageArtifactTargets>[0],
		)
	}

	/**
	 * External publish (KODY-CLOUDFLARE-57) clones into ephemeral FS and never
	 * populates the session Durable Object workspace. The long-lived
	 * `external-publish-${sourceId}` DO can still hold a leftover workspace
	 * from an older clone or initialize(), so listing and staging must prefer
	 * the published source snapshot written from that in-memory clone.
	 */
	private async readPackageManifestForPublishedArtifacts(
		source: EntitySourceRow,
	) {
		const manifestSnapshot = await loadPublishedSourceManifestSnapshot({
			env: this.env,
			userId: source.user_id,
			source,
		})
		if (typeof manifestSnapshot?.manifestContent === 'string') {
			return parseAuthoredPackageJson({
				content: manifestSnapshot.manifestContent,
				manifestPath: source.manifest_path,
			})
		}
		const snapshot = await loadPublishedSourceSnapshot({
			env: this.env,
			userId: source.user_id,
			source,
		})
		const snapshotContent = snapshot?.files[source.manifest_path]
		if (typeof snapshotContent === 'string') {
			return parseAuthoredPackageJson({
				content: snapshotContent,
				manifestPath: source.manifest_path,
			})
		}
		const workspaceContent = await this.workspace.readFile(
			resolveRepoWorkspacePath(
				source.manifest_path,
				repoSessionWorkspacePrefix,
			),
		)
		if (typeof workspaceContent === 'string') {
			return parseAuthoredPackageJson({
				content: workspaceContent,
				manifestPath: source.manifest_path,
			})
		}
		throw new Error(`Manifest "${source.manifest_path}" was not found.`)
	}

	private assertPublishedCommitUnchanged(input: {
		source: EntitySourceRow
		publishedCommit: string
	}) {
		const currentCommit = input.source.published_commit?.trim() || null
		if (currentCommit === input.publishedCommit) return
		throw new Error(
			`Published commit changed from "${input.publishedCommit}" to "${currentCommit ?? 'unpublished'}" during package artifact rebuild; retry this package.`,
		)
	}

	/**
	 * Load source files for the requested published commit's immutable snapshot.
	 * Never stages the current source row's commit when the caller asked for a
	 * different one — that mislabels newer files under an older commit.
	 * Workspace fallback is only allowed when the source is still at that
	 * commit (re-checked after a snapshot miss).
	 */
	private async collectSourceFilesForPublishedArtifactRebuild(
		source: EntitySourceRow,
		publishedCommit: string,
	) {
		const sourceAtPublishedCommit = {
			...source,
			published_commit: publishedCommit,
		}
		const snapshot = await loadPublishedSourceSnapshot({
			env: this.env,
			userId: source.user_id,
			source: sourceAtPublishedCommit,
		})
		if (snapshot && typeof snapshot.files[source.manifest_path] === 'string') {
			return snapshot.files
		}
		// Snapshot miss: only fall back to the session workspace when the
		// source is still published at the requested commit.
		const freshSource = await this.resolvePublishSource({
			sourceId: source.id,
			userId: source.user_id,
		})
		this.assertPublishedCommitUnchanged({
			source: freshSource,
			publishedCommit,
		})
		const workspaceFiles = await this.collectWorkspaceFiles()
		if (typeof workspaceFiles[source.manifest_path] === 'string') {
			return workspaceFiles
		}
		throw new Error(`Manifest "${source.manifest_path}" was not found.`)
	}

	async initialize(input: {
		sessionId: string
		repoRemote: string
		repoToken: string
		sessionBranch?: string | null
	}): Promise<void> {
		if (this.initializedSessionId === input.sessionId) return
		const gitConfigPath = `${repoSessionWorkspacePrefix}/.git/config`
		const hasGitDir = await this.workspace.exists(gitConfigPath)
		if (hasGitDir) {
			const hasExpectedOrigin = await this.hasExpectedOriginRemote(
				input.repoRemote,
			)
			if (!hasExpectedOrigin) {
				await this.resetWorkspace()
			}
		}
		const hasCleanGitDir = await this.workspace.exists(gitConfigPath)
		if (!hasCleanGitDir) {
			await this.cloneArtifactsRepoWithRetry({
				remote: input.repoRemote,
				token: input.repoToken,
				branch: input.sessionBranch,
			})
		}
		this.initializedSessionId = input.sessionId
	}

	private async applyWorkspaceEdits(input: {
		edits: Array<RepoSessionEdit>
		dryRun?: boolean
		rollbackOnError?: boolean
	}): Promise<RepoSessionApplyEditsResult> {
		type WorkspaceContentEdit = Exclude<
			RepoSessionEdit,
			{ kind: 'delete' } | { kind: 'move' }
		>
		type WorkspaceStructuralEdit = Extract<
			RepoSessionEdit,
			{ kind: 'delete' } | { kind: 'move' }
		>
		const contentEdits: Array<WorkspaceContentEdit> = []
		const structuralEdits: Array<WorkspaceStructuralEdit> = []
		for (const edit of input.edits) {
			switch (edit.kind) {
				case 'write':
				case 'replace':
				case 'writeJson':
					contentEdits.push(edit)
					break
				case 'delete':
				case 'move':
					structuralEdits.push(edit)
					break
				default: {
					const exhaustive: never = edit
					return exhaustive
				}
			}
		}

		// Structural edits (delete/move) execute after content edits, so a batch
		// that touches the same path from both sides has ambiguous,
		// order-dependent results (a write can be silently discarded). Reject
		// those batches outright: callers split them into separate calls.
		// Comparison keys use the resolved workspace path so aliased
		// spellings (`./src/a.ts`, `src/../exports/a.ts`) still collide.
		const editConflictKey = (path: string) =>
			resolveRepoWorkspacePath(path, repoSessionWorkspacePrefix)
		const contentEditConflictKeys = new Set(
			contentEdits.map((edit) => editConflictKey(edit.path)).filter(Boolean),
		)
		const assertNoContentConflict = (path: string) => {
			if (contentEditConflictKeys.has(editConflictKey(path))) {
				throw new Error(
					`repo session edits cannot combine a delete/move touching "${path}" with a write/replace/writeJson edit for the same path in one call. Split them into separate repoEditFiles calls.`,
				)
			}
		}
		type PlannedStructuralEdit = {
			kind: 'delete' | 'move'
			path: string
			to?: string
			workspacePath: string
			targetWorkspacePath?: string
			changed: boolean
			content: string
			diff: string
		}
		const plannedStructural: Array<PlannedStructuralEdit> = []
		const moveTargets = new Set<string>()
		for (const edit of structuralEdits) {
			if (edit.kind === 'delete') {
				const path = edit.path.trim()
				if (!path) {
					throw new Error('repo session delete edits require path.')
				}
				const workspacePath = resolveRepoWorkspacePath(
					path,
					repoSessionWorkspacePrefix,
				)
				assertNoContentConflict(path)
				const exists = await this.workspace.exists(workspacePath)
				if (!exists) {
					throw new Error(
						`repo session delete edit target "${path}" was not found.`,
					)
				}
				const currentContent =
					(await this.workspace.readFile(workspacePath)) ?? ''
				plannedStructural.push({
					kind: 'delete',
					path,
					workspacePath,
					changed: true,
					content: '',
					diff: formatPatch({
						oldFileName: `a/${path}`,
						newFileName: '/dev/null',
						oldHeader: '',
						newHeader: '',
						hunks: [
							{
								oldStart: 1,
								oldLines: currentContent.split('\n').length,
								newStart: 0,
								newLines: 0,
								lines: currentContent.split('\n').map((line) => `-${line}`),
							},
						],
					}),
				})
				continue
			}
			const fromPath = edit.path.trim()
			const toPath = edit.to?.trim() ?? ''
			if (!fromPath || !toPath) {
				throw new Error('repo session move edits require path and to.')
			}
			if (fromPath === toPath) {
				throw new Error(
					`repo session move edit source and destination are the same: "${fromPath}".`,
				)
			}
			if (moveTargets.has(editConflictKey(toPath))) {
				throw new Error(
					`repo session move edits cannot target the same destination twice: "${toPath}".`,
				)
			}
			moveTargets.add(editConflictKey(toPath))
			const sourceWorkspacePath = resolveRepoWorkspacePath(
				fromPath,
				repoSessionWorkspacePrefix,
			)
			const targetWorkspacePath = resolveRepoWorkspacePath(
				toPath,
				repoSessionWorkspacePrefix,
			)
			assertNoContentConflict(fromPath)
			assertNoContentConflict(toPath)
			const sourceExists = await this.workspace.exists(sourceWorkspacePath)
			if (!sourceExists) {
				throw new Error(
					`repo session move edit source "${fromPath}" was not found.`,
				)
			}
			const targetExists = await this.workspace.exists(targetWorkspacePath)
			if (targetExists) {
				throw new Error(
					`repo session move edit destination "${toPath}" already exists.`,
				)
			}
			const currentContent =
				(await this.workspace.readFile(sourceWorkspacePath)) ?? ''
			plannedStructural.push({
				kind: 'move',
				path: toPath,
				to: toPath,
				workspacePath: sourceWorkspacePath,
				targetWorkspacePath,
				changed: true,
				content: currentContent,
				diff: formatPatch({
					oldFileName: `a/${fromPath}`,
					newFileName: `b/${toPath}`,
					oldHeader: '',
					newHeader: '',
					hunks: [
						{
							oldStart: 1,
							oldLines: currentContent.split('\n').length,
							newStart: 1,
							newLines: currentContent.split('\n').length,
							lines: currentContent.split('\n').map((line) => ` ${line}`),
						},
					],
				}),
			})
		}

		let contentResult: RepoSessionApplyEditsResult = {
			dryRun: input.dryRun ?? false,
			totalChanged: 0,
			edits: [],
		}
		if (contentEdits.length > 0) {
			// @cloudflare/shell planEdits reads every instruction against the
			// file at batch start, so same-path writes overwrite one another.
			// Plan through a staged overlay so sequential edits observe prior
			// results, matching applyUnifiedDiff and the batch contract.
			const plan = await planRepoSessionContentEdits(
				contentEdits.map((edit) => {
					const path = resolveRepoWorkspacePath(
						edit.path,
						repoSessionWorkspacePrefix,
					)
					switch (edit.kind) {
						case 'write':
							if (typeof edit.content !== 'string') {
								throw new Error('repo session write edits require content.')
							}
							return {
								kind: 'write' as const,
								path,
								content: edit.content,
							}
						case 'replace':
							if (typeof edit.search !== 'string') {
								throw new Error('repo session replace edits require search.')
							}
							return {
								kind: 'replace' as const,
								path,
								search: edit.search,
								replacement: edit.replacement ?? '',
								options: edit.options,
							}
						case 'writeJson':
							if (edit.value === undefined) {
								throw new Error('repo session writeJson edits require a value.')
							}
							return {
								kind: 'writeJson' as const,
								path,
								value: edit.value,
								options:
									typeof edit.options?.spaces === 'number'
										? { spaces: edit.options.spaces }
										: undefined,
							}
						default: {
							const exhaustive: never = edit
							return exhaustive
						}
					}
				}),
				async (path) => (await this.workspace.readFile(path)) ?? null,
			)
			// Track prior contents the same way `@cloudflare/shell`
			// `applyTextEdits` does: each changed edit diffs previous → next,
			// and a write earlier in the batch updates previous for later
			// same-path edits. Gate both sides against the shell line ceiling
			// before applyEditPlan so agents never see raw EFBIG.
			const previousContentByPath = new Map<string, string>()
			for (const plannedEdit of plan.edits) {
				const externalPath = toExternalRepoPath(
					plannedEdit.path,
					repoSessionWorkspacePrefix,
				)
				const previousContent = previousContentByPath.has(plannedEdit.path)
					? (previousContentByPath.get(plannedEdit.path) ?? '')
					: ((await this.workspace.readFile(plannedEdit.path)) ?? '')
				if (plannedEdit.changed) {
					const previousLineCount = measureRepoSourceFileLines(previousContent)
					const nextLineCount = measureRepoSourceFileLines(plannedEdit.content)
					if (
						previousLineCount > maxRepoSourceFileDiffLines ||
						nextLineCount > maxRepoSourceFileDiffLines
					) {
						throw new Error(
							buildRepoDiffTooLargeMessage({
								path: externalPath,
								lineCount: Math.max(previousLineCount, nextLineCount),
							}),
						)
					}
					const byteLength = measureRepoSourceFileBytes(plannedEdit.content)
					if (byteLength > maxRepoSourceFileBytes) {
						throw new Error(
							buildRepoLargeFileMessage({
								path: externalPath,
								byteLength,
							}),
						)
					}
				}
				previousContentByPath.set(plannedEdit.path, plannedEdit.content)
			}
			let appliedPlan: {
				dryRun: boolean
				totalChanged: number
				edits: Array<{
					path: string
					changed: boolean
					content: string
					diff: string
				}>
			}
			try {
				appliedPlan = await this.state.applyEditPlan(plan, {
					dryRun: input.dryRun,
					rollbackOnError: input.rollbackOnError,
				})
			} catch (error) {
				// Defense in depth: remap any shell EFBIG that slipped past
				// preflight (or arrived wrapped in StateBatchOperationError).
				const message = error instanceof Error ? error.message : String(error)
				if (isRepoDiffTooLargeMessage(message) && message.includes('EFBIG')) {
					const oversized = plan.edits.find((edit) => {
						if (!edit.changed) return false
						return (
							measureRepoSourceFileLines(edit.content) >
							maxRepoSourceFileDiffLines
						)
					})
					const path = oversized
						? toExternalRepoPath(oversized.path, repoSessionWorkspacePrefix)
						: toExternalRepoPath(
								plan.edits.find((edit) => edit.changed)?.path ??
									plan.edits[0]?.path ??
									'file',
								repoSessionWorkspacePrefix,
							)
					const lineCount = oversized
						? measureRepoSourceFileLines(oversized.content)
						: maxRepoSourceFileDiffLines + 1
					throw new Error(buildRepoDiffTooLargeMessage({ path, lineCount }))
				}
				throw error
			}
			contentResult = {
				dryRun: appliedPlan.dryRun,
				totalChanged: appliedPlan.totalChanged,
				edits: appliedPlan.edits.map((edit) => ({
					path: toExternalRepoPath(edit.path, repoSessionWorkspacePrefix),
					changed: edit.changed,
					content: edit.content,
					diff: edit.diff,
				})),
			}
		}

		if (!input.dryRun) {
			for (const planned of plannedStructural) {
				if (planned.kind === 'delete') {
					await this.workspace.rm(planned.workspacePath, { force: true })
					continue
				}
				await this.workspace.writeFile(
					planned.targetWorkspacePath ?? planned.workspacePath,
					planned.content,
				)
				await this.workspace.rm(planned.workspacePath, { force: true })
			}
		}

		const structuralResults = plannedStructural.map((planned) => ({
			path: planned.path,
			changed: planned.changed,
			content: planned.content,
			diff: planned.diff,
		}))
		return {
			dryRun: input.dryRun ?? false,
			totalChanged:
				contentResult.totalChanged +
				structuralResults.filter((edit) => edit.changed).length,
			edits: [...contentResult.edits, ...structuralResults],
		}
	}

	async openSession(input: {
		sessionId: string
		sourceId: string
		userId: OwnerId
		baseUrl: string
		conversationId?: string | null
		sourceRoot?: string | null
		defaultBranch?: string | null
	}) {
		let sessionRow = await getRepoSessionById(this.env, {
			userId: input.userId,
			sessionId: input.sessionId,
		})
		if (!sessionRow) {
			const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
			if (!source) {
				throw new Error(`Source "${input.sourceId}" was not found.`)
			}
			if (source.user_id !== input.userId) {
				throw new Error(
					`Source "${input.sourceId}" was not found for this user.`,
				)
			}
			const baseCommit =
				source.entity_kind === 'repo'
					? await resolveLiveSourceHeadCommit(this.env, source)
					: source.published_commit
			if (!baseCommit) {
				throw new Error(
					source.entity_kind === 'repo'
						? `Plain repo "${source.repo_id}" has no commits yet. Push an initial commit through the git lane before opening a session.`
						: `Source "${source.id}" has no published commit yet. Bootstrap the source repo before opening a repo session.`,
				)
			}
			const sourceHead =
				source.entity_kind === 'package'
					? await assertPublishedPackageSourceRepoHead({
							env: this.env,
							source,
							operation: 'repoOpenSession',
							requirePublishedCommitHead: true,
						})
					: null
			const sourceRepo =
				sourceHead?.repo ??
				(await resolveArtifactSourceRepo(this.env, source.repo_id))
			const sourceAccess = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
				pendingReconcile: buildPendingExternalReconcile(
					this.env.APP_DB,
					source,
				),
			})
			const sourceBranch =
				sourceHead?.defaultBranch ??
				input.defaultBranch ??
				(await sourceRepo.info())?.defaultBranch ??
				defaultSessionBranch
			if (
				sourceHead &&
				input.defaultBranch &&
				input.defaultBranch !== sourceBranch
			) {
				throw new Error(
					`Source "${source.id}" is published from "${sourceBranch}", not "${input.defaultBranch}".`,
				)
			}
			const sessionBranch = buildSessionBranchName(input.sessionId)
			await this.cloneArtifactsRepoWithRetry({
				remote: sourceAccess.remote,
				token: sourceAccess.token,
				branch: sourceBranch,
				resetBeforeFirstAttempt: true,
			})
			await (
				await this.ensureGit()
			).checkout({
				dir: repoSessionWorkspacePrefix,
				ref: baseCommit,
				force: true,
			})
			await (
				await this.ensureGit()
			).checkout({
				dir: repoSessionWorkspacePrefix,
				branch: sessionBranch,
			})
			await (
				await this.ensureGit()
			).push({
				dir: repoSessionWorkspacePrefix,
				remote: 'origin',
				ref: sessionBranch,
				...buildArtifactsGitAuth({ token: sourceAccess.token }),
			})
			try {
				const now = nowIso()
				const newSessionRow: RepoSessionRow = {
					id: input.sessionId,
					user_id: input.userId,
					source_id: input.sourceId,
					source_repo_id: source.repo_id,
					session_branch: sessionBranch,
					source_branch: sourceBranch,
					base_commit: baseCommit ?? '',
					source_root: input.sourceRoot ?? source.source_root,
					conversation_id: input.conversationId ?? null,
					status: 'active',
					expires_at: null,
					last_checkpoint_at: null,
					last_checkpoint_commit: baseCommit,
					last_check_run_id: null,
					last_check_tree_hash: null,
					created_at: now,
					updated_at: now,
				}
				await insertRepoSession(this.env, newSessionRow)
				sessionRow = newSessionRow
			} catch (error) {
				await this.deleteRemoteBranch({
					branch: sessionBranch,
					token: sourceAccess.token,
				}).catch(() => {})
				throw error
			}
		} else {
			if (sessionRow.user_id !== input.userId) {
				throw new Error(buildRepoSessionNotFoundForUserMessage(input.sessionId))
			}
			if (sessionRow.status !== 'active') {
				throw new Error(
					`Repo session "${input.sessionId}" is ${sessionRow.status}; open a new session before continuing.`,
				)
			}
			const source = await getEntitySourceById(
				this.env.APP_DB,
				sessionRow.source_id,
			)
			if (!source) {
				throw new Error(`Source "${sessionRow.source_id}" was not found.`)
			}
			const sourceRepo = await resolveArtifactSourceRepo(
				this.env,
				source.repo_id,
			)
			const access = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
				pendingReconcile: buildPendingExternalReconcile(
					this.env.APP_DB,
					source,
				),
			})
			await this.initialize({
				sessionId: sessionRow.id,
				repoRemote: access.remote,
				repoToken: access.token,
				sessionBranch: sessionRow.session_branch,
			})
		}
		const source = await getEntitySourceById(
			this.env.APP_DB,
			sessionRow.source_id,
		)
		if (!source) {
			throw new Error(`Source "${sessionRow.source_id}" was not found.`)
		}
		await this.writeCachedSessionState({ sessionRow, source })
		await registerStorageBucketAndWait({
			env: this.env,
			userId: sessionRow.user_id,
			storageId: repoSessionStorageBucketId(sessionRow.id),
			kind: 'repo_session',
		})
		this.refreshStoredEstimate(sessionRow.id, sessionRow.user_id)
		return toRepoSessionInfoResult(sessionRow, source)
	}

	async bootstrapSource(input: {
		sessionId: string
		sourceId: string
		userId: OwnerId
		bootstrapAccess?: ArtifactBootstrapAccess | null
		existingHeadCommit?: string
		/**
		 * Forwarded to `runRepoChecks`. Community forks may also set
		 * `runPublishChecks: false` so install can persist an inert source
		 * before its own checks choose live vs adaptation. Default matches
		 * `publishFromExternalRef` (docs required) when checks run.
		 */
		requirePackageDocs?: boolean
		/**
		 * Forwarded to `runRepoChecks`. Platform codemods pass false so
		 * legacy credential patterns stay migratable (#3836 phase 1).
		 */
		enforceCredentialStamp?: boolean
		/**
		 * When false, skip the throwing publish-check gate. Community install
		 * persists first and evaluates checks separately.
		 */
		runPublishChecks?: boolean
		/**
		 * Forwarded to `runRepoChecks` so bootstrap rejects a wrong
		 * `package.json#name` scope before advancing published_commit.
		 */
		expectedPackageScope?: string
		edits: Array<{
			kind: 'write' | 'replace' | 'writeJson'
			path: string
			content?: string
			search?: string
			replacement?: string
			value?: unknown
			options?: {
				caseSensitive?: boolean
				regex?: boolean
				wholeWord?: boolean
				contextBefore?: number
				contextAfter?: number
				maxMatches?: number
				spaces?: number
			}
		}>
	}): Promise<RepoSourceBootstrapResult> {
		const serverTiming: Array<ServerTimingEntry> = []
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source) {
			throw new Error(`Source "${input.sourceId}" was not found.`)
		}
		if (source.user_id !== input.userId) {
			throw new Error(`Source "${input.sourceId}" was not found for this user.`)
		}
		if (source.published_commit) {
			throw new Error(
				`Source "${source.id}" already has a published commit. Use repo sessions for later edits.`,
			)
		}
		const remoteSetup = await pushServerTiming(
			serverTiming,
			'bootstrap-artifact-remote',
			async () => {
				if (input.bootstrapAccess) {
					return {
						remote: input.bootstrapAccess.remote,
						token: input.bootstrapAccess.token,
						sourceInfo: null,
					}
				}
				const sourceRepo = await resolveArtifactSourceRepo(
					this.env,
					source.repo_id,
				)
				const sourceInfo = await sourceRepo.info()
				const access = await ensureArtifactRepoRemote({
					repo: sourceRepo,
					scope: 'write',
					pendingReconcile: buildPendingExternalReconcile(
						this.env.APP_DB,
						source,
					),
				})
				return {
					remote: access.remote,
					token: access.token,
					sourceInfo,
				}
			},
		)
		const targetBranch =
			input.bootstrapAccess?.defaultBranch ??
			remoteSetup.sourceInfo?.defaultBranch ??
			defaultSessionBranch
		const sourceRemoteUrl = buildAuthenticatedArtifactsRemote({
			remote: remoteSetup.remote,
			token: remoteSetup.token,
		})
		if (input.existingHeadCommit) {
			await pushServerTiming(serverTiming, 'bootstrap-git-clone', async () => {
				await this.cloneArtifactsRepoWithRetry({
					remote: remoteSetup.remote,
					token: remoteSetup.token,
					branch: targetBranch,
					resetBeforeFirstAttempt: true,
				})
				const head = await this.getHeadCommit()
				if (head !== input.existingHeadCommit) {
					throw new Error(
						`Forked dest HEAD "${head ?? 'none'}" does not match expected "${input.existingHeadCommit}".`,
					)
				}
				await this.ensureRemote({
					name: 'source',
					url: sourceRemoteUrl,
				})
			})
		} else {
			await pushServerTiming(serverTiming, 'bootstrap-git-init', async () => {
				await this.resetWorkspace()
				await this.workspace.mkdir(repoSessionWorkspacePrefix, {
					recursive: true,
				})
				await (
					await this.ensureGit()
				).init({
					dir: repoSessionWorkspacePrefix,
					defaultBranch: targetBranch,
				})
				await this.ensureRemote({
					name: 'source',
					url: sourceRemoteUrl,
				})
			})
		}
		await pushServerTiming(serverTiming, 'bootstrap-write-files', () =>
			this.applyWorkspaceEdits({
				edits: input.edits as Array<RepoSessionEdit>,
				dryRun: false,
				rollbackOnError: true,
			}),
		)
		const publishedCommit = await pushServerTiming(
			serverTiming,
			'bootstrap-commit',
			async () => {
				const commit = await this.commitIfDirty(
					`Bootstrap source repo ${source.id}`,
				)
				if (!commit) {
					throw new Error(`Source "${source.id}" bootstrap produced no commit.`)
				}
				switch (source.entity_kind) {
					case 'package':
						await this.readManifestFromWorkspace(source.manifest_path)
						break
					case 'repo':
						break
					default: {
						const entityKind: never = source.entity_kind
						throw new Error(`Unsupported entity kind: ${String(entityKind)}`)
					}
				}
				return commit
			},
		)
		if (source.entity_kind === 'package' && input.runPublishChecks !== false) {
			await pushServerTiming(
				serverTiming,
				'bootstrap-repo-checks',
				async () => {
					const manifestPath = resolveRepoWorkspacePath(
						source.manifest_path,
						repoSessionWorkspacePrefix,
					)
					const sourceRoot = resolveRepoWorkspacePath(
						source.source_root || repoSessionWorkspacePrefix,
						repoSessionWorkspacePrefix,
					)
					const checks = await runRepoChecks({
						workspace: this.workspace,
						manifestPath,
						sourceRoot,
						env: this.env,
						baseUrl: source.source_root,
						userId: input.userId,
						sourceId: source.id,
						...(input.expectedPackageScope !== undefined
							? { expectedPackageScope: input.expectedPackageScope }
							: {}),
						...(input.requirePackageDocs === false
							? { requirePackageDocs: false }
							: {}),
						...(input.enforceCredentialStamp === false
							? { enforceCredentialStamp: false }
							: {}),
					})
					if (!checks.ok) {
						throw new RepoChecksFailedError(
							formatFailedRepoCheckMessages(checks.results),
						)
					}
				},
			)
		}
		const snapshotFiles = await pushServerTiming(
			serverTiming,
			'bootstrap-workspace-snapshot',
			() => this.collectWorkspaceFiles(),
		)
		if (input.existingHeadCommit && Object.keys(snapshotFiles).length === 0) {
			throw new Error(
				`Source "${source.id}" first-publish from dest HEAD produced an empty workspace snapshot.`,
			)
		}
		await pushServerTiming(serverTiming, 'bootstrap-git-push', async () =>
			(await this.ensureGit()).push({
				dir: repoSessionWorkspacePrefix,
				remote: 'source',
				ref: targetBranch,
				...buildArtifactsGitAuth({ token: remoteSetup.token }),
			}),
		)
		await pushServerTiming(serverTiming, 'bootstrap-git-note', () =>
			this.attachSourcePublishGitNote({
				source,
				commitOid: publishedCommit,
				remote: remoteSetup.remote,
				token: remoteSetup.token,
				remoteName: 'source',
				publishedBy: 'source_bootstrap',
				sessionId: input.sessionId,
				previousPublishedCommit: null,
				scope: 'repo.bootstrapSource.publish-git-note',
			}),
		)
		await pushServerTiming(serverTiming, 'bootstrap-published-commit', () =>
			updateEntitySource(this.env.APP_DB, {
				id: source.id,
				userId: source.user_id,
				publishedCommit,
				manifestPath: source.manifest_path,
				sourceRoot: source.source_root,
			}),
		)
		return {
			sessionId: input.sessionId,
			publishedCommit,
			message: `Bootstrapped source ${source.id} in ${source.repo_id}.`,
			files: snapshotFiles,
			serverTiming,
		}
	}

	async getSessionInfo(input: { sessionId: string; userId: OwnerId }) {
		const { sessionRow, source } = await this.getSessionState(
			input.sessionId,
			input.userId,
			{
				allowedStatuses: ['active', 'published'],
				// Catalog + heal only: never re-clone published scratch.
				initialize: false,
			},
		)
		// Lazy heal: older publishes kept counting workspace bytes until
		// discard/expiry. Release scratch the first time a published session
		// still holding inventory is inspected.
		if (
			sessionRow.status === 'published' &&
			(await storageBucketInventoryExists({
				db: this.env.APP_DB,
				userId: sessionRow.user_id,
				storageId: repoSessionStorageBucketId(sessionRow.id),
			}))
		) {
			await this.releasePublishedSessionScratch(
				sessionRow.id,
				sessionRow.user_id,
			)
		}
		await this.touchRepoSession(sessionRow)
		return toRepoSessionInfoResult(sessionRow, source)
	}

	async discardSession(input: {
		sessionId: string
		userId: OwnerId
	}): Promise<RepoSessionDiscardResult> {
		const sessionRow = await getRepoSessionById(this.env, {
			userId: input.userId,
			sessionId: input.sessionId,
		})
		if (!sessionRow) {
			await this.clearCachedSessionState(input.sessionId)
			await this.deleteStorageInventory(input.sessionId, input.userId)
			return {
				ok: true,
				sessionId: input.sessionId,
				deleted: false,
			}
		}
		if (sessionRow.user_id !== input.userId) {
			throw new Error(buildRepoSessionNotFoundForUserMessage(input.sessionId))
		}
		await updateRepoSession(this.env, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'discarded',
			expiresAt: buildPublishedSessionExpiresAt(),
			lastCheckpointAt: nowIso(),
		})
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace()
		await this.purgeWorkspaceBlobs()
		await this.deleteStorageInventory(input.sessionId, sessionRow.user_id)
		return {
			ok: true,
			sessionId: input.sessionId,
			deleted: true,
		}
	}

	async purgeSession(input: { sessionId: string; userId: OwnerId }) {
		const sessionRow = await getRepoSessionById(this.env, {
			userId: input.userId,
			sessionId: input.sessionId,
		})
		if (sessionRow && sessionRow.user_id !== input.userId) {
			throw new Error(buildRepoSessionNotFoundForUserMessage(input.sessionId))
		}
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace().catch(() => {
			// deleteAll below clears the SQLite-backed workspace state even if the
			// higher-level workspace adapter cannot remove a path cleanly.
		})
		this.inMemorySessionState.delete(input.sessionId)
		this.initializedSessionId = null
		await this.ctx.storage.deleteAll()
		await this.purgeWorkspaceBlobs()
		await this.deleteStorageInventory(input.sessionId, input.userId)
		return {
			ok: true as const,
			sessionId: input.sessionId,
		}
	}

	async cleanupSessionBranch(input: {
		sessionId: string
		userId: OwnerId
		reason: 'expired' | 'abandoned' | 'source_deleted'
	}) {
		const sessionRow = await getRepoSessionById(this.env, {
			userId: input.userId,
			sessionId: input.sessionId,
		})
		if (!sessionRow) {
			await this.deleteStorageInventory(input.sessionId, input.userId)
			return {
				ok: true as const,
				sessionId: input.sessionId,
				branch: '',
				branchDeleted: true,
			}
		}
		if (sessionRow.user_id !== input.userId) {
			throw new Error(buildRepoSessionNotFoundForUserMessage(input.sessionId))
		}
		const sessionBranch = sessionRow.session_branch
		// Remote branch delete is best-effort. Cron selects the same expired
		// rows every tick until the catalog row is removed; a sticky remote
		// failure (for example a broken raw-git fs adapter) must not pin those
		// rows forever and burn ~50 DO wakes each scheduled run.
		let branchDeleted = false
		try {
			branchDeleted = await this.deleteSessionRemoteBranch({
				sessionRow,
			})
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'repo session remote branch delete failed',
					reason: input.reason,
					sessionId: input.sessionId,
					branch: sessionBranch,
					error: getErrorMessage(error),
				}),
			)
		}
		await this.clearCachedSessionState(input.sessionId)
		await this.resetWorkspace().catch(() => {
			// Workspace wipe is best-effort; prefix purge below is the R2 safety net.
		})
		// Purge before dropping the catalog row so a failed R2 delete keeps the
		// row for cron retry. A missing row is not ownership proof — do not wipe.
		await this.purgeWorkspaceBlobs()
		await deleteRepoSession(this.env, {
			userId: input.userId,
			sessionId: input.sessionId,
		})
		await this.deleteStorageInventory(input.sessionId, sessionRow.user_id)
		console.info(
			JSON.stringify({
				message: branchDeleted
					? 'repo session branch deleted'
					: 'repo session cleanup completed without remote branch delete',
				reason: input.reason,
			}),
		)
		return {
			ok: true as const,
			sessionId: input.sessionId,
			branch: sessionBranch,
			branchDeleted,
		}
	}

	private async deleteSessionRemoteBranch(input: {
		sessionRow: RepoSessionRow
	}): Promise<boolean> {
		const sessionBranch = input.sessionRow.session_branch
		const source = await getEntitySourceById(
			this.env.APP_DB,
			input.sessionRow.source_id,
		)
		if (!source) {
			const sourceRepo = await resolveExistingArtifactSourceRepo(
				this.env,
				input.sessionRow.source_repo_id,
			)
			if (!sourceRepo) {
				return true
			}
			const access = await ensureArtifactRepoRemote({
				repo: sourceRepo,
				scope: 'write',
			})
			await this.initialize({
				sessionId: input.sessionRow.id,
				repoRemote: access.remote,
				repoToken: access.token,
				sessionBranch,
			})
			await this.deleteRemoteBranch({
				branch: sessionBranch,
				token: access.token,
			})
			return true
		}
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const access = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'write',
			pendingReconcile: buildPendingExternalReconcile(this.env.APP_DB, source),
		})
		await this.initialize({
			sessionId: input.sessionRow.id,
			repoRemote: access.remote,
			repoToken: access.token,
			sessionBranch,
		})
		await this.deleteRemoteBranch({
			branch: sessionBranch,
			token: access.token,
		})
		return true
	}

	async readFile(input: {
		sessionId: string
		userId: OwnerId
		path: string
	}): Promise<{ path: string; content: string | null }> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
		return {
			path: input.path,
			content: await this.workspace.readFile(
				resolveRepoWorkspacePath(input.path, repoSessionWorkspacePrefix),
			),
		}
	}

	async writeFile(input: {
		sessionId: string
		userId: OwnerId
		path: string
		content: string
	}): Promise<{ ok: true; path: string }> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const byteLength = measureRepoSourceFileBytes(input.content)
		if (byteLength > maxRepoSourceFileBytes) {
			throw new Error(
				buildRepoLargeFileMessage({ path: input.path, byteLength }),
			)
		}
		await this.workspace.writeFile(
			resolveRepoWorkspacePath(input.path, repoSessionWorkspacePrefix),
			input.content,
		)
		await updateRepoSession(this.env, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
		})
		this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		return { ok: true, path: input.path }
	}

	async search(input: {
		sessionId: string
		userId: OwnerId
		pattern: string
		mode?: RepoSearchMode
		glob?: string | null
		path?: string | null
		caseSensitive?: boolean
		before?: number
		after?: number
		limit?: number
		outputMode?: RepoSearchOutputMode
	}): Promise<RepoSessionSearchResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
		const root = resolveRepoWorkspacePath(
			input.path?.trim() ||
				sessionRow.source_root ||
				repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		return searchRepoWorkspace({
			workspace: this.workspace,
			root,
			pattern: input.pattern,
			mode: input.mode,
			glob: input.glob,
			caseSensitive: input.caseSensitive,
			before: input.before,
			after: input.after,
			limit: input.limit,
			outputMode: input.outputMode,
			toExternalPath: (path) =>
				toExternalRepoPath(path, repoSessionWorkspacePrefix),
		})
	}

	private async applyUnifiedDiff(input: { patch: string; dryRun?: boolean }) {
		let parsedSections
		try {
			parsedSections = splitUnifiedDiffSections(input.patch).flatMap(
				(section) =>
					parsePatch(section.text).map((patch) => ({
						patch,
						header: section.header,
					})),
			)
		} catch (error) {
			// `diff` parsePatch throws plain Errors (malformed hunks, line-count
			// mismatches). Remap so DO RPC still classifies them as caller
			// failures while preserving the actionable parse detail and a
			// hunk-header hint agents can act on. KODY-A3 / KODY-A4.
			throw new Error(
				buildRepoApplyPatchParseCallerMessage(getErrorMessage(error)),
				{ cause: error },
			)
		}
		if (parsedSections.length === 0) {
			throw new Error('git apply patch did not contain any file changes.')
		}
		const edits: Array<{
			path: string
			changed: boolean
			content: string
			diff: string
		}> = []
		// Two phases so a patch set is all-or-nothing: plan (and validate) every
		// patch before any workspace mutation, so an unclean or oversized later
		// patch cannot leave earlier patches partially applied. The staged
		// overlay lets sequential patches in one set observe prior results in
		// both dry-run and real apply.
		const stagedContents = new Map<string, string | null>()
		const plannedOps: Array<{
			workspacePath: string
			sourceWorkspacePath: string
			isDelete: boolean
			isRename: boolean
			nextContent: string
		}> = []
		for (const { patch, header } of parsedSections) {
			const resolvedNames = resolveUnifiedDiffFileNames(patch, header)
			// Keep formatPatch / isDelete aligned with the names we actually used.
			patch.oldFileName = resolvedNames.oldFileName
			patch.newFileName = resolvedNames.newFileName
			const oldPath = stripUnifiedDiffPath(resolvedNames.oldFileName)
			const newPath = stripUnifiedDiffPath(resolvedNames.newFileName)
			const targetPath = newPath ?? oldPath
			const sourcePath = oldPath ?? newPath
			if (!targetPath || !sourcePath) {
				throw new Error('git apply patch is missing a target file path.')
			}
			const workspacePath = resolveRepoWorkspacePath(
				targetPath,
				repoSessionWorkspacePrefix,
			)
			const sourceWorkspacePath = resolveRepoWorkspacePath(
				sourcePath,
				repoSessionWorkspacePrefix,
			)
			const stagedContent = stagedContents.get(sourceWorkspacePath)
			const currentContent =
				stagedContent !== undefined
					? (stagedContent ?? '')
					: ((await this.workspace.readFile(sourceWorkspacePath)) ?? '')
			const nextContent = applyPatch(currentContent, patch)
			if (nextContent === false) {
				throw new Error(
					`git apply patch did not apply cleanly to ${targetPath}.`,
				)
			}
			const patchedByteLength = measureRepoSourceFileBytes(nextContent)
			if (patchedByteLength > maxRepoSourceFileBytes) {
				throw new Error(
					buildRepoLargeFileMessage({
						path: targetPath,
						byteLength: patchedByteLength,
					}),
				)
			}
			const isDelete = resolvedNames.newFileName === '/dev/null'
			const isRename = Boolean(oldPath && newPath && oldPath !== newPath)
			if (isDelete) {
				stagedContents.set(workspacePath, null)
			} else {
				stagedContents.set(workspacePath, nextContent)
				if (isRename) {
					stagedContents.set(sourceWorkspacePath, null)
				}
			}
			plannedOps.push({
				workspacePath,
				sourceWorkspacePath,
				isDelete,
				isRename,
				nextContent,
			})
			edits.push({
				path: targetPath,
				changed: nextContent !== currentContent,
				content: nextContent,
				diff: formatPatch(patch),
			})
		}
		if (!input.dryRun) {
			for (const op of plannedOps) {
				if (op.isDelete) {
					await this.workspace.rm(op.workspacePath, { force: true })
				} else {
					await this.workspace.writeFile(op.workspacePath, op.nextContent)
					if (op.isRename) {
						await this.workspace.rm(op.sourceWorkspacePath, { force: true })
					}
				}
			}
		}
		return {
			dryRun: input.dryRun ?? false,
			totalChanged: edits.filter((edit) => edit.changed).length,
			edits,
		}
	}

	async applyPatch(input: {
		sessionId: string
		userId: OwnerId
		patch: string
		dryRun?: boolean
	}): Promise<RepoSessionApplyEditsResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const result = await this.applyUnifiedDiff({
			patch: input.patch,
			dryRun: input.dryRun,
		})
		if (!input.dryRun) {
			await updateRepoSession(this.env, {
				id: input.sessionId,
				userId: sessionRow.user_id,
				lastCheckpointAt: nowIso(),
			})
			this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		}
		return result
	}

	async sessionStatus(input: { sessionId: string; userId: OwnerId }) {
		await this.getSessionState(input.sessionId, input.userId)
		return (await this.ensureGit()).status({ dir: repoSessionWorkspacePrefix })
	}

	async sessionDiff(input: { sessionId: string; userId: OwnerId }) {
		await this.getSessionState(input.sessionId, input.userId)
		return (await this.ensureGit()).diff({ dir: repoSessionWorkspacePrefix })
	}

	async sessionLog(input: {
		sessionId: string
		userId: OwnerId
		depth?: number
	}) {
		await this.getSessionState(input.sessionId, input.userId)
		return (await this.ensureGit()).log({
			dir: repoSessionWorkspacePrefix,
			depth: input.depth,
		})
	}

	async sessionCommit(input: {
		sessionId: string
		userId: OwnerId
		message: string
	}) {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		if (!input.message.trim()) {
			throw new Error('Commit message cannot be empty.')
		}
		await (
			await this.ensureGit()
		).add({
			dir: repoSessionWorkspacePrefix,
			filepath: '.',
		})
		const commit = await (
			await this.ensureGit()
		).commit({
			dir: repoSessionWorkspacePrefix,
			message: input.message,
			author: sessionCommitAuthor,
		})
		await updateRepoSession(this.env, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
			lastCheckpointCommit: commit.oid,
		})
		this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		return {
			oid: commit.oid,
			message: input.message,
		}
	}

	async restoreFiles(input: {
		sessionId: string
		userId: OwnerId
		paths: Array<string>
		commit?: string
	}) {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		if (input.paths.length === 0) {
			throw new Error('Provide at least one path to restore.')
		}
		const commit = input.commit ?? sessionRow.base_commit
		const { git } = await loadIsomorphicGit()
		const plannedRestores: Array<{
			path: string
			workspacePath: string
			// Raw blob bytes: decoding to a string would corrupt binary files
			// (invalid UTF-8 becomes U+FFFD), so restores write bytes verbatim.
			bytes: Uint8Array
		}> = []
		for (const path of input.paths) {
			const trimmedPath = path.trim()
			if (!trimmedPath) {
				throw new Error('Restore paths cannot be empty.')
			}
			try {
				const result = await git.readBlob({
					fs: this.rawGitFileSystem,
					dir: repoSessionWorkspacePrefix,
					oid: commit,
					filepath: trimmedPath,
				})
				plannedRestores.push({
					path: trimmedPath,
					workspacePath: resolveRepoWorkspacePath(
						trimmedPath,
						repoSessionWorkspacePrefix,
					),
					bytes: result.blob,
				})
			} catch (error) {
				throw new Error(
					`Path "${trimmedPath}" was not found at commit ${commit}.`,
					{ cause: error },
				)
			}
		}
		for (const restore of plannedRestores) {
			await this.workspace.writeFileBytes(restore.workspacePath, restore.bytes)
		}
		await updateRepoSession(this.env, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckpointAt: nowIso(),
		})
		this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		return {
			commit,
			restored: plannedRestores.map((restore) => restore.path),
		}
	}

	async tree(input: {
		sessionId: string
		userId: OwnerId
		path?: string | null
		maxDepth?: number
	}): Promise<RepoSessionTreeResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
		const root = resolveRepoWorkspacePath(
			input.path?.trim() ||
				sessionRow.source_root ||
				repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		const tree = await this.state.walkTree(root, {
			maxDepth: input.maxDepth,
		})
		return toRepoSessionTreeResult({
			node: tree,
			workspacePrefix: repoSessionWorkspacePrefix,
		})
	}

	async applyEdits(input: {
		sessionId: string
		userId: OwnerId
		edits: Array<RepoSessionEdit>
		dryRun?: boolean
		rollbackOnError?: boolean
	}): Promise<RepoSessionApplyEditsResult> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const result = await this.applyWorkspaceEdits(input)
		if (!input.dryRun) {
			await updateRepoSession(this.env, {
				id: input.sessionId,
				userId: sessionRow.user_id,
				lastCheckpointAt: nowIso(),
			})
			this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		}
		return result
	}

	async runChecks(input: {
		sessionId: string
		userId: OwnerId
		expectedPackageScope?: string
		/**
		 * Forwarded to `runRepoChecks`. Codemod / community lanes may pass
		 * `false`; authoring publish defaults to requiring docs.
		 */
		requirePackageDocs?: boolean
		/**
		 * Forwarded to `runRepoChecks`. Codemod / community lanes may pass
		 * `false`; authoring publish defaults to enforcing the stamp.
		 */
		enforceCredentialStamp?: boolean
	}): Promise<RepoSessionCheckRun> {
		const { sessionRow, source } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const manifestPath = resolveRepoWorkspacePath(
			source.manifest_path,
			repoSessionWorkspacePrefix,
		)
		const sourceRoot = resolveRepoWorkspacePath(
			source.source_root || repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		const result = await runRepoChecks({
			workspace: this.workspace,
			manifestPath,
			sourceRoot,
			env: this.env,
			baseUrl: source.source_root,
			userId: input.userId,
			sourceId: source.id,
			// Honor an explicit scope even on a still-plain repo: promote
			// runs package checks before flipping entity_kind.
			expectedPackageScope: input.expectedPackageScope,
			...(input.requirePackageDocs === false
				? { requirePackageDocs: false }
				: {}),
			...(input.enforceCredentialStamp === false
				? { enforceCredentialStamp: false }
				: {}),
		})
		const { sourceFiles: _sourceFiles, ...publicResult } = result
		const runId = crypto.randomUUID()
		const treeHash = await this.computeTreeHash()
		const checkedAt = nowIso()
		await updateRepoSession(this.env, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckRunId: runId,
			lastCheckTreeHash: treeHash,
			lastCheckpointAt: checkedAt,
		})
		await this.writeCheckStatus({
			runId,
			treeHash,
			checkedAt,
			ok: publicResult.ok,
			results: publicResult.results.map((entry) => ({
				kind: entry.kind,
				ok: entry.ok,
				message: entry.message,
			})),
		})
		this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		return {
			...publicResult,
			runId,
			treeHash,
			checkedAt,
		}
	}

	async getCheckStatus(input: { sessionId: string; userId: OwnerId }) {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		await this.touchRepoSession(sessionRow)
		return this.readCheckStatus()
	}

	/**
	 * Stamp an ok check-status for the current workspace tree without running
	 * validators. Trusted opt-out for community inert-fork persist
	 * (`runPublishChecks: false`): publishSession can then proceed without
	 * `force`, so the destructive-overwrite gate stays intact. Do not use this
	 * to weaken `publishFromExternalRef` / packageSave (those keep real checks).
	 */
	async acceptCurrentTreeForPublish(input: {
		sessionId: string
		userId: OwnerId
	}): Promise<RepoSessionCheckStatus> {
		const { sessionRow } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const runId = crypto.randomUUID()
		const treeHash = await this.computeTreeHash()
		const checkedAt = nowIso()
		const status: RepoSessionCheckStatus = {
			runId,
			treeHash,
			checkedAt,
			ok: true,
			results: [
				{
					kind: 'manifest',
					ok: true,
					message:
						'Publish checks accepted without running validators (trusted opt-out).',
				},
			],
		}
		await updateRepoSession(this.env, {
			id: input.sessionId,
			userId: sessionRow.user_id,
			lastCheckRunId: runId,
			lastCheckTreeHash: treeHash,
			lastCheckpointAt: checkedAt,
		})
		await this.writeCheckStatus(status)
		this.refreshStoredEstimate(input.sessionId, sessionRow.user_id)
		return status
	}

	/**
	 * Pure-compute entrypoint for one heavy repo-check phase, invoked on a
	 * throwaway Durable Object id so the phase's peak memory lives in its own
	 * isolate (see isolated-check-phases.ts and kody-hq/kody#987). It has
	 * no session and never touches this instance's storage; the staged source
	 * files come from a short-TTL KV entry written by the orchestrating
	 * checks run.
	 */
	async runIsolatedCheckPhase(
		input: IsolatedCheckPhaseRequest,
	): Promise<IsolatedCheckPhaseOutcome> {
		if (
			!isolatedCheckStagingKeyBelongsToUser({
				stagingKey: input.stagingKey,
				userId: input.userId,
			})
		) {
			return {
				ok: false,
				message:
					'Isolated check phase staging key does not belong to the requesting user.',
			}
		}
		const staged = await this.env.BUNDLE_ARTIFACTS_KV.get<{
			sourceFiles?: Record<string, string>
		}>(input.stagingKey, 'json')
		const sourceFiles = staged?.sourceFiles
		if (!sourceFiles) {
			return {
				ok: false,
				message:
					'Isolated check phase staging data expired or is missing; run the checks again.',
			}
		}
		if (input.phase === 'bundle-chunk') {
			return await validatePackageBundles({
				env: this.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceFiles,
				entryPoints: input.bundleTargets,
			})
		}
		if (input.phase === 'typecheck') {
			return await runPackageTypecheckLanguageService({
				sourceFiles,
				targets: input.typecheckTargets,
			})
		}
		const exhaustive: never = input
		throw new Error(
			`Unsupported isolated check phase: ${JSON.stringify(exhaustive)}`,
		)
	}

	async listPublishedPackageArtifactTargets(input: {
		sessionId?: string
		sourceId?: string
		userId: OwnerId
	}): Promise<Array<PublishedPackageArtifactBuildTarget>> {
		const source = await this.resolvePublishSource(input)
		return await this.listPackageArtifactTargetsForSource(source)
	}

	/**
	 * Collect the requested published commit's immutable snapshot once on the
	 * long-lived publish session and stage it in KV for throwaway rebuild
	 * isolates (see isolated-artifact-rebuild.ts). Callers list and filter
	 * targets before staging so already-built resumes skip this work.
	 * Rejects when the source's current published commit differs so a
	 * concurrent publish cannot stage newer files under an older label.
	 */
	async stagePublishedPackageArtifactRebuild(input: {
		sessionId?: string
		sourceId?: string
		userId: OwnerId
		publishedCommit: string
	}): Promise<{
		stagingKey: string
	}> {
		const source = await this.resolvePublishSource(input)
		if (source.entity_kind !== 'package') {
			throw new Error(
				'Published bundle artifacts can only be rebuilt for packages.',
			)
		}
		this.assertPublishedCommitUnchanged({
			source,
			publishedCommit: input.publishedCommit,
		})
		const stagingKv = (this.env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
			.BUNDLE_ARTIFACTS_KV
		if (!stagingKv) {
			throw new Error(
				'BUNDLE_ARTIFACTS_KV binding is required to stage published package artifact rebuilds.',
			)
		}
		const sourceFiles =
			await this.collectSourceFilesForPublishedArtifactRebuild(
				source,
				input.publishedCommit,
			)
		const stagingKey = isolatedArtifactRebuildStagingKeyForUser(input.userId)
		await stagingKv.put(
			stagingKey,
			JSON.stringify({
				sourceFiles,
				publishedCommit: input.publishedCommit,
			}),
			{
				expirationTtl: isolatedArtifactRebuildStagingTtlSeconds,
			},
		)
		return { stagingKey }
	}

	/**
	 * Pure-compute entrypoint for a chunk of published-package artifact
	 * rebuilds, invoked on a throwaway Durable Object id so the rebuild's
	 * peak memory lives in its own isolate (see isolated-artifact-rebuild.ts).
	 * It has no session and never touches this instance's storage; the staged
	 * source files come from a short-TTL KV entry written by
	 * `stagePublishedPackageArtifactRebuild`.
	 */
	async runIsolatedArtifactRebuild(
		input: IsolatedArtifactRebuildRequest,
	): Promise<IsolatedArtifactRebuildOutcome> {
		const failTargets = (
			targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>,
			message: string,
		): Array<IsolatedArtifactRebuildTargetResult> =>
			targets.map((target) => ({
				ok: false,
				message,
				target,
			}))

		if (
			!isolatedArtifactRebuildStagingKeyBelongsToUser({
				stagingKey: input.stagingKey,
				userId: input.userId,
			})
		) {
			const message =
				'Isolated artifact rebuild staging key does not belong to the requesting user.'
			return {
				ok: false,
				message,
				results: failTargets(input.targets, message),
			}
		}
		const results: Array<IsolatedArtifactRebuildTargetResult> = []
		const remaining: Array<PublishedPackageArtifactBuildTarget> = []
		const snapshotCache = new Map()
		for (const target of input.targets) {
			const alreadyBuilt =
				!input.force &&
				(await isPublishedPackageArtifactBuiltForCommit({
					env: this.env,
					userId: input.userId,
					sourceId: input.sourceId,
					publishedCommit: input.publishedCommit,
					target,
					snapshotCache,
				}))
			if (alreadyBuilt) {
				results.push({
					ok: true,
					message: 'Published package artifact already built for this commit.',
					skipped: true,
					kvKey: null,
					target,
				})
				continue
			}
			remaining.push(target)
		}
		if (remaining.length === 0) {
			return {
				ok: true,
				message: 'Published package artifacts already built for this commit.',
				results,
			}
		}
		const staged = await this.env.BUNDLE_ARTIFACTS_KV.get<{
			sourceFiles?: Record<string, string>
			publishedCommit?: string
		}>(input.stagingKey, 'json')
		const sourceFiles = staged?.sourceFiles
		if (!sourceFiles) {
			const message =
				'Isolated artifact rebuild staging data expired or is missing; re-run the publish capability to repair artifacts.'
			results.push(...failTargets(remaining, message))
			return { ok: false, message, results }
		}
		if (
			typeof staged.publishedCommit === 'string' &&
			staged.publishedCommit !== input.publishedCommit
		) {
			const message = `Isolated artifact rebuild staging was for commit "${staged.publishedCommit}" but rebuild requested "${input.publishedCommit}".`
			results.push(...failTargets(remaining, message))
			return { ok: false, message, results }
		}
		try {
			const source = await this.resolvePublishSource({
				sourceId: input.sourceId,
				userId: input.userId,
			})
			if (source.entity_kind !== 'package') {
				const message =
					'Published bundle artifacts can only be rebuilt for packages.'
				results.push(...failTargets(remaining, message))
				return { ok: false, message, results }
			}
			// Reject before writing so a publish that landed after staging
			// cannot leave newer files labeled as the caller's older commit.
			this.assertPublishedCommitUnchanged({
				source,
				publishedCommit: input.publishedCommit,
			})
			const savedPackage = await getSavedPackageById(this.env.APP_DB, {
				userId: input.userId,
				packageId: source.entity_id,
			})
			if (!savedPackage) {
				const message = `Saved package "${source.entity_id}" was not found.`
				results.push(...failTargets(remaining, message))
				return { ok: false, message, results }
			}
			const prepareCache: PreparedKodyGraphCache = new Map()
			for (const target of remaining) {
				try {
					const kvKey =
						await this.persistPublishedPackageArtifactTargetFromFiles({
							source,
							savedPackage,
							userId: input.userId,
							publishedCommit: input.publishedCommit,
							target,
							baseUrl: input.baseUrl,
							sourceFiles,
							prepareCache,
						})
					results.push({
						ok: true,
						message: 'Published package artifact rebuilt.',
						kvKey,
						target,
					})
				} catch (error) {
					results.push({
						ok: false,
						message: getErrorMessage(error),
						...(isUserCodeError(error) ? { callerFailure: true } : {}),
						target,
					})
				}
			}
		} catch (error) {
			const message = getErrorMessage(error)
			const recorded = new Set(results.map((result) => result.target))
			for (const target of remaining) {
				if (recorded.has(target)) continue
				results.push({
					ok: false,
					message,
					target,
				})
			}
			return { ok: false, message, results }
		}

		const failed = results.filter((result) => !result.ok)
		if (failed.length === 0) {
			return {
				ok: true,
				message: 'Published package artifacts rebuilt.',
				results,
			}
		}
		return {
			ok: false,
			message: failed.map((result) => result.message).join('; '),
			results,
		}
	}

	async rebuildPublishedPackageArtifact(input: {
		sessionId?: string
		sourceId?: string
		userId: OwnerId
		publishedCommit: string
		target: PublishedPackageArtifactBuildTarget
		baseUrl?: string
	}): Promise<{
		ok: true
		target: PublishedPackageArtifactBuildTarget
		kvKey: string | null
	}> {
		const source = await this.resolvePublishSource(input)
		if (source.entity_kind !== 'package') {
			throw new Error(
				'Published bundle artifacts can only be rebuilt for packages.',
			)
		}
		this.assertPublishedCommitUnchanged({
			source,
			publishedCommit: input.publishedCommit,
		})
		const savedPackage = await getSavedPackageById(this.env.APP_DB, {
			userId: input.userId,
			packageId: source.entity_id,
		})
		if (!savedPackage) {
			throw new Error(`Saved package "${source.entity_id}" was not found.`)
		}
		const sourceFiles =
			await this.collectSourceFilesForPublishedArtifactRebuild(
				source,
				input.publishedCommit,
			)
		// Re-check immediately before persist: staging/collection is not
		// atomic with a concurrent publish updating the source row.
		const freshSource = await this.resolvePublishSource(input)
		this.assertPublishedCommitUnchanged({
			source: freshSource,
			publishedCommit: input.publishedCommit,
		})
		const kvKey = await this.persistPublishedPackageArtifactTargetFromFiles({
			source: freshSource,
			savedPackage,
			userId: input.userId,
			publishedCommit: input.publishedCommit,
			target: input.target,
			baseUrl: input.baseUrl,
			sourceFiles,
		})
		return {
			ok: true,
			target: input.target,
			kvKey,
		}
	}

	private async persistPublishedPackageArtifactTargetFromFiles(input: {
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		userId: OwnerId
		publishedCommit: string
		target: PublishedPackageArtifactBuildTarget
		baseUrl?: string
		sourceFiles: Record<string, string>
		prepareCache?: PreparedKodyGraphCache
	}) {
		const sourceAtPublishedCommit = {
			...input.source,
			published_commit: input.publishedCommit,
		}
		const {
			buildKodyAppBundle,
			buildKodyAppClientBundle,
			buildKodyModuleBundle,
			buildKodyImportableModuleBundle,
		} = await import('#worker/package-runtime/module-graph.ts')
		const prepareCache = input.prepareCache ?? new Map()
		return await persistPublishedPackageArtifactTarget({
			env: this.env,
			userId: input.userId,
			source: sourceAtPublishedCommit,
			savedPackage: input.savedPackage,
			target: input.target,
			buildAppBundle: async ({ entryPoint }) =>
				await buildKodyAppBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? input.source.source_root,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint,
					rootPackageId: input.savedPackage.id,
					cacheKey: null,
					prepareCache,
				}),
			buildAppClientBundle: async ({ entryPoint }) =>
				await buildKodyAppClientBundle({
					sourceFiles: input.sourceFiles,
					entryPoint,
				}),
			buildModuleBundle: async ({ entryPoint }) =>
				await buildKodyModuleBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? input.source.source_root,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint,
					rootPackageId: input.savedPackage.id,
					prepareCache,
				}),
			buildImportableModuleBundle: async ({ entryPoint }) =>
				await buildKodyImportableModuleBundle({
					env: this.env,
					baseUrl: input.baseUrl ?? input.source.source_root,
					userId: input.userId,
					sourceFiles: input.sourceFiles,
					entryPoint,
					rootPackageId: input.savedPackage.id,
					prepareCache,
				}),
		})
	}

	async rebaseSession(input: {
		sessionId: string
		userId: OwnerId
	}): Promise<RepoSessionRebaseResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		const sessionBranch = sessionRow.session_branch
		const pullResult = await (
			await this.ensureGit()
		).pull({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionRow.source_branch,
			author: sessionCommitAuthor,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		const headCommit = await this.getHeadCommit()
		// Session branches are ephemeral workspace state; pull/merge can rewrite
		// history, so force-push the session ref (never the source branch).
		await (
			await this.ensureGit()
		).push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionBranch,
			force: true,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		// Resolve the live head exactly once so the persisted base_commit and
		// the returned baseCommit cannot diverge when a push lands in between.
		// Packages stay on D1 published_commit: Artifacts HEAD can include
		// unpublished git-lane pushes that must not become the session base.
		const rebasedBaseCommit =
			source.entity_kind === 'repo'
				? ((await resolveLiveSourceHeadCommit(this.env, source)) ?? '')
				: (source.published_commit ?? '')
		await updateRepoSession(this.env, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			baseCommit: rebasedBaseCommit,
			lastCheckpointCommit: headCommit,
			lastCheckpointAt: nowIso(),
		})
		this.refreshStoredEstimate(sessionRow.id, sessionRow.user_id)
		return {
			ok: true,
			sessionId: sessionRow.id,
			baseCommit: rebasedBaseCommit,
			headCommit,
			merged: pullResult.pulled,
		}
	}

	private async publishPlainRepoSession(input: {
		sessionRow: RepoSessionRow
		source: EntitySourceRow
		sessionAccess: { token: string; remote: string }
		commitMessage?: string
	}): Promise<RepoSessionPublishResult> {
		const sessionBranch = input.sessionRow.session_branch
		const sourceRoot = resolveRepoWorkspacePath(
			input.sessionRow.source_root || repoSessionWorkspacePrefix,
			repoSessionWorkspacePrefix,
		)
		const walk = await runRepoSourceWalkChecks({
			workspace: this.workspace,
			sourceRoot,
		})
		if (!walk.ok) {
			return {
				status: 'checks_outdated',
				sessionId: input.sessionRow.id,
				publishedCommit: null,
				message: walk.message,
			}
		}
		const liveHead = await resolveLiveSourceHeadCommit(this.env, input.source)
		if ((liveHead ?? '') !== input.sessionRow.base_commit) {
			return {
				status: 'base_moved',
				sessionId: input.sessionRow.id,
				publishedCommit: null,
				sessionBaseCommit: input.sessionRow.base_commit,
				currentPublishedCommit: liveHead,
				repairHint: 'repoRebaseSession',
				message:
					'The source repo has moved since this session opened. Rebase the session before publishing.',
			}
		}
		const sessionHeadCommit =
			(await this.commitIfDirty(
				input.commitMessage?.trim() ||
					`Publish repo session ${input.sessionRow.id}`,
			)) ?? (await this.getHeadCommit())
		await (
			await this.ensureGit()
		).push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionBranch,
			force: true,
			...buildArtifactsGitAuth({ token: input.sessionAccess.token }),
		})
		try {
			await this.pushBranchToRemoteRef({
				branch: sessionBranch,
				remoteRef: input.sessionRow.source_branch,
				token: input.sessionAccess.token,
			})
		} catch (error) {
			if (isGitPushNotFastForwardError(error)) {
				const refreshedHead = await resolveLiveSourceHeadCommit(
					this.env,
					input.source,
				)
				return this.buildPublishBaseMovedResult({
					sessionId: input.sessionRow.id,
					sessionBaseCommit: input.sessionRow.base_commit,
					currentPublishedCommit: refreshedHead ?? liveHead,
				})
			}
			throw error
		}
		const publishedCommit = sessionHeadCommit ?? input.sessionRow.base_commit
		await this.attachSourcePublishGitNote({
			source: input.source,
			commitOid: publishedCommit,
			remote: input.sessionAccess.remote,
			token: input.sessionAccess.token,
			remoteName: 'origin',
			publishedBy: 'repo_session',
			sessionId: input.sessionRow.id,
			conversationId: input.sessionRow.conversation_id,
			baseCommit: input.sessionRow.base_commit,
			previousPublishedCommit: liveHead,
			checks: null,
			scope: 'repo.publishPlainRepoSession.publish-git-note',
		})
		await updateRepoSession(this.env, {
			id: input.sessionRow.id,
			userId: input.sessionRow.user_id,
			status: 'published',
			baseCommit: publishedCommit,
			lastCheckpointCommit: publishedCommit,
			lastCheckpointAt: nowIso(),
			expiresAt: buildPublishedSessionExpiresAt(),
		})
		await this.writeCachedSessionState({
			sessionRow: {
				...input.sessionRow,
				status: 'published',
				base_commit: publishedCommit,
				last_checkpoint_commit: publishedCommit,
			},
			source: {
				...input.source,
				published_commit: publishedCommit,
			},
		})
		await this.releasePublishedSessionScratch(
			input.sessionRow.id,
			input.sessionRow.user_id,
		)
		return {
			status: 'ok',
			sessionId: input.sessionRow.id,
			publishedCommit,
			message: `Published plain repo session ${input.sessionRow.id} to ${input.source.repo_id}. ${publishedSessionScratchReleasedNotice}`,
		}
	}

	async publishSession(input: {
		sessionId: string
		userId: OwnerId
		force?: boolean
		destructiveOverwriteConfirmed?: boolean
		privateVisibilityChangeConfirmed?: boolean
		rebuildPackageArtifacts?: boolean
		expectedPackageScope?: string
		commitMessage?: string
		allowLockedPublish?: boolean
		credentialNeedsApproved?: boolean
		requestedByUserId?: string | null
		promotePublished?: boolean
		/** Refuse unless the session still holds exactly this commit. */
		expectedHeadCommit?: string
	}): Promise<RepoSessionPublishResult> {
		const { sessionRow, source, sessionAccess } = await this.getSessionState(
			input.sessionId,
			input.userId,
		)
		switch (source.entity_kind) {
			case 'repo':
				return await this.publishPlainRepoSession({
					sessionRow,
					source,
					sessionAccess,
					commitMessage: input.commitMessage,
				})
			case 'package':
				break
			default: {
				const entityKind: never = source.entity_kind
				throw new Error(`Unsupported entity kind: ${String(entityKind)}`)
			}
		}
		const sessionBranch = sessionRow.session_branch
		const checkStatus = await this.readCheckStatus()
		const workspaceSnapshot = await this.collectWorkspacePublishSnapshot()
		const currentTreeHash = workspaceSnapshot.treeHash
		if (
			(!input.force && !checkStatus.runId) ||
			(!input.force && !checkStatus.ok) ||
			(!input.force && checkStatus.treeHash !== currentTreeHash)
		) {
			return {
				status: 'checks_outdated',
				sessionId: input.sessionId,
				publishedCommit: null,
				message:
					'Run repoRunChecks on the current session state before publishing.',
			}
		}
		if ((source.published_commit ?? '') !== sessionRow.base_commit) {
			return {
				status: 'base_moved',
				sessionId: input.sessionId,
				publishedCommit: null,
				sessionBaseCommit: sessionRow.base_commit,
				currentPublishedCommit: source.published_commit,
				repairHint: 'repoRebaseSession',
				message:
					'The source repo has moved since this session opened. Rebase the session before publishing.',
			}
		}
		const replaceHistory =
			input.force === true &&
			input.destructiveOverwriteConfirmed === true &&
			input.promotePublished !== false &&
			source.entity_kind === 'package'
		if (input.force === true && source.entity_kind === 'package') {
			await assertPackageSourceOverwriteAllowed({
				env: this.env,
				userId: input.userId,
				source,
				operation: 'repo forced publish',
				confirmed: input.destructiveOverwriteConfirmed,
			})
		}
		if (source.entity_kind === 'package') {
			const afterContent = workspaceSnapshot.files[source.manifest_path]
			if (typeof afterContent !== 'string') {
				throw new Error(`Manifest "${source.manifest_path}" was not found.`)
			}
			const beforeContent = await loadPriorPackageManifestContent({
				env: this.env,
				userId: input.userId,
				source,
			})
			assertPackagePrivateVisibilityChangeAllowed({
				beforeContent,
				afterContent,
				isNewPackage: false,
				operation: 'repo publish',
				confirmed: input.privateVisibilityChangeConfirmed,
			})
		}
		// A re-run of a paused publish must publish the commit it paused on, so
		// it never mints a new history-replacing commit.
		const sessionHeadCommit =
			(await this.commitIfDirty(
				input.commitMessage?.trim() ||
					`Publish repo session ${input.sessionId}`,
				replaceHistory && input.expectedHeadCommit === undefined
					? { replaceHistory: true }
					: undefined,
			)) ?? (await this.getHeadCommit())
		if (
			input.expectedHeadCommit !== undefined &&
			(sessionHeadCommit ?? sessionRow.base_commit) !== input.expectedHeadCommit
		) {
			throw new Error(
				pausedSessionMovedMessage(input.sessionId, input.expectedHeadCommit),
			)
		}
		await this.readManifestFromWorkspace(
			source.manifest_path,
			input.expectedPackageScope,
		)
		await (
			await this.ensureGit()
		).push({
			dir: repoSessionWorkspacePrefix,
			remote: 'origin',
			ref: sessionBranch,
			force: true,
			...buildArtifactsGitAuth({ token: sessionAccess.token }),
		})
		// Commit/push do not rewrite workspace file bytes, so reuse the
		// snapshot collected once above for the published source KV write.
		const snapshotFiles = workspaceSnapshot.files
		const publishedCommit = sessionHeadCommit ?? sessionRow.base_commit
		const patternNotice =
			source.entity_kind === 'package'
				? credentialPatternNoticeForFiles(snapshotFiles, source.source_root)
				: null
		const secretMountCompat =
			source.entity_kind === 'package'
				? await loadSecretMountCompatNotice({
						env: this.env,
						userId: input.userId,
						sourceId: source.id,
						nextCommit: publishedCommit,
						nextFiles: snapshotFiles,
						previousCommit: source.published_commit,
						sourceRoot: source.source_root,
					})
				: null
		// Warning is independent of the locked-publish gate: lookup/scan failures
		// must never change lock or approve results (fail-closed lock stays intact).
		const allowedPackagesPublishNotice =
			source.entity_kind === 'package'
				? await loadCredentialAllowedPackagesPublishWarningNotice({
						env: this.env,
						baseUrl: getAppBaseUrl({ env: this.env }),
						userId: input.userId,
						packageId: source.entity_id,
						files: snapshotFiles,
						sourceRoot: source.source_root,
					})
				: null
		const credentialNotice =
			[patternNotice, secretMountCompat, allowedPackagesPublishNotice]
				.filter((notice): notice is string => Boolean(notice))
				.join('\n\n') || null
		const withCredentialNotice = (message: string) =>
			credentialNotice ? `${message}\n\n${credentialNotice}` : message
		const lockedPackage =
			source.entity_kind === 'package' &&
			input.allowLockedPublish !== true &&
			input.promotePublished !== false
				? await loadLockedSavedPackage({
						db: this.env.APP_DB,
						userId: input.userId,
						packageId: source.entity_id,
					})
				: null
		// The pause runs before the source branch moves, so the published commit
		// stays at HEAD and new sessions open as usual. The session (and its
		// pushed branch) holds the paused commit until approval re-runs it. A
		// locked package keeps its locked-publish flow; approving that publish
		// runs this gate.
		const approval =
			input.credentialNeedsApproved === true ||
			input.promotePublished === false ||
			lockedPackage
				? null
				: await requireCredentialNeedsApproval({
						env: this.env,
						source,
						pendingCommit: publishedCommit,
						files: snapshotFiles,
						requestedByUserId: input.requestedByUserId,
						pausedSession: {
							sessionId: sessionRow.id,
							force: input.force === true,
							destructiveOverwriteConfirmed:
								input.destructiveOverwriteConfirmed === true,
							privateVisibilityChangeConfirmed:
								input.privateVisibilityChangeConfirmed === true,
							...(input.expectedPackageScope !== undefined
								? { expectedPackageScope: input.expectedPackageScope }
								: {}),
						},
					})
		if (approval) {
			await updateRepoSession(this.env, {
				id: sessionRow.id,
				userId: sessionRow.user_id,
				lastCheckpointCommit: publishedCommit,
				lastCheckpointAt: nowIso(),
			})
			return {
				status: 'approval_required',
				sessionId: input.sessionId,
				publishedCommit: null,
				currentPublishedCommit: source.published_commit,
				message: approval.message,
				approval,
				credentialNotice,
			}
		}
		const forceSourcePush = input.force === true
		try {
			await this.pushBranchToRemoteRef({
				branch: sessionBranch,
				remoteRef: sessionRow.source_branch,
				token: sessionAccess.token,
				...(forceSourcePush ? { force: true } : {}),
			})
		} catch (error) {
			if (!forceSourcePush && isGitPushNotFastForwardError(error)) {
				const refreshedHead = await resolveLiveSourceHeadCommit(
					this.env,
					source,
				)
				return this.buildPublishBaseMovedResult({
					sessionId: input.sessionId,
					sessionBaseCommit: sessionRow.base_commit,
					currentPublishedCommit: refreshedHead ?? source.published_commit,
				})
			}
			throw error
		}
		if (input.promotePublished === false) {
			return {
				status: 'ok',
				sessionId: input.sessionId,
				publishedCommit,
				message: `Pushed session ${input.sessionId} to ${source.repo_id} without promoting published_commit.`,
			}
		}
		if (lockedPackage) {
			const error = createPackagePublishLockedError({
				savedPackage: lockedPackage,
				pendingCommit: publishedCommit,
				currentPublishedCommit: source.published_commit,
			})
			return {
				status: 'locked',
				sessionId: input.sessionId,
				publishedCommit: null,
				pendingCommit: publishedCommit,
				currentPublishedCommit: source.published_commit,
				packageId: lockedPackage.id,
				packageName: lockedPackage.name,
				message: error.message,
				credentialNotice,
			}
		}
		await finalizePublishedEntitySource({
			env: this.env,
			source,
			publishedCommit,
			files: snapshotFiles,
			baseUrl: source.source_root,
			rebuildPackageArtifacts: input.rebuildPackageArtifacts ?? true,
			allowLockedPublish: input.allowLockedPublish,
			actorUserId: input.requestedByUserId ?? undefined,
		})
		if (replaceHistory) {
			await this.deleteAdvertisedSessionBranches({
				sessionBranch,
				remote: sessionAccess.remote,
				token: sessionAccess.token,
			})
		}
		await this.attachSourcePublishGitNote({
			source,
			commitOid: publishedCommit,
			remote: sessionAccess.remote,
			token: sessionAccess.token,
			remoteName: 'origin',
			publishedBy: 'repo_session',
			sessionId: sessionRow.id,
			conversationId: sessionRow.conversation_id,
			baseCommit: sessionRow.base_commit,
			previousPublishedCommit: source.published_commit,
			checks: this.buildPublishGitNoteChecks(checkStatus),
			scope: 'repo.publishSession.publish-git-note',
		})
		await updateRepoSession(this.env, {
			id: sessionRow.id,
			userId: sessionRow.user_id,
			status: 'published',
			baseCommit: sessionHeadCommit ?? sessionRow.base_commit,
			lastCheckpointCommit: sessionHeadCommit,
			lastCheckpointAt: nowIso(),
			expiresAt: buildPublishedSessionExpiresAt(),
		})
		await this.writeCachedSessionState({
			sessionRow: {
				...sessionRow,
				status: 'published',
				base_commit: publishedCommit,
				last_checkpoint_commit: sessionHeadCommit,
			},
			source: {
				...source,
				published_commit: publishedCommit,
			},
		})
		await this.releasePublishedSessionScratch(sessionRow.id, sessionRow.user_id)
		return {
			status: 'ok',
			sessionId: sessionRow.id,
			publishedCommit: sessionHeadCommit ?? sessionRow.base_commit,
			message: withCredentialNotice(
				`Published session ${sessionRow.id} to ${source.repo_id}. ${publishedSessionScratchReleasedNotice}`,
			),
		}
	}

	/**
	 * In-memory clone of one source commit, the workspace publish checks read.
	 * Shared by {@link publishFromExternalRef} and {@link checkExternalRef} so
	 * the approve-publish preview checks exactly what Promote will check.
	 */
	private async cloneExternalRefForPublish(input: {
		source: EntitySourceRow
		commit: string
		expectedHead?: string | null
		phaseTimings: PublishPhaseTimings
	}) {
		const { source } = input
		const sourceRepo = await resolveArtifactSourceRepo(this.env, source.repo_id)
		const sourceInfo = await sourceRepo.info()
		const sourceAccess = await ensureArtifactRepoRemote({
			repo: sourceRepo,
			scope: 'read',
		})
		const targetBranch = sourceInfo?.defaultBranch ?? defaultSessionBranch
		let publishClone: Awaited<ReturnType<typeof cloneExternalPublishWorkspace>>
		try {
			// In-memory clone: publish verification does not need the session
			// Durable Object workspace (KODY-CLOUDFLARE-57).
			;({ value: publishClone } = await timePublishExternalPushPhase(
				{ phase: 'clone', sourceId: source.id, timings: input.phaseTimings },
				async () => {
					const cloned = await cloneExternalPublishWorkspace({
						remote: sourceAccess.remote,
						token: sourceAccess.token,
						branch: targetBranch,
						checkoutCommit: input.commit,
					})
					// Race protection without a second Artifacts REST HEAD resolve:
					// the single-branch clone tip is the remote default-branch HEAD
					// at clone time. Compare it to the worker-resolved expectedHead
					// before publish.
					if (input.expectedHead) {
						const clonedHead = cloned.headCommit
						if (clonedHead !== input.expectedHead) {
							throw new Error(
								`Artifacts HEAD changed from "${input.expectedHead}" to "${clonedHead ?? 'unknown'}" before publish.`,
							)
						}
					}
					return cloned
				},
			))
		} catch (error) {
			const classified = classifyExternalPublishCloneError(error, input.commit)
			switch (classified.kind) {
				case 'rethrow':
					throw error
				case 'unknown_commit':
					throw classified.error
				case 'storage':
					throw new Error(
						buildWorkspaceSqliteTooBigCallerMessage(
							'packagePublishExternalPush',
						),
						{ cause: error },
					)
				case 'source_recovery':
					throw new Error(
						buildSourceRecoveryProblemMessage({
							source,
							operation: 'packagePublishExternalPush',
							reason: classified.reason,
						}),
						{ cause: error },
					)
				default: {
					const exhaustive: never = classified
					throw new Error(
						`Unhandled external publish clone failure: ${String(exhaustive)}`,
					)
				}
			}
		}
		return { sourceRepo, publishClone }
	}

	/**
	 * Run the authoring publish checks on one pushed commit without publishing,
	 * moving HEAD, or touching the session workspace. The approve-publish page
	 * calls this so a failing commit shows its failures before Promote.
	 */
	async checkExternalRef(input: {
		sourceId: string
		userId: OwnerId
		commit: string
		baseUrl?: string
		expectedPackageScope?: string
	}): Promise<RepoExternalRefCheckResult> {
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source || source.user_id !== input.userId) {
			throw new Error('Repo source was not found for this user.')
		}
		if (source.entity_kind !== 'package') {
			throw new Error('Publish checks run on packages only.')
		}
		const phaseTimings: PublishPhaseTimings = {}
		const { publishClone } = await this.cloneExternalRefForPublish({
			source,
			commit: input.commit,
			phaseTimings,
		})
		const publishDir = publishClone.dir || externalPublishWorkspaceDir
		const checks = await runAuthoringPublishChecks({
			workspace: publishClone.workspace,
			manifestPath: resolveRepoWorkspacePath(source.manifest_path, publishDir),
			sourceRoot: resolveRepoWorkspacePath(
				source.source_root || publishDir,
				publishDir,
			),
			env: this.env,
			baseUrl: input.baseUrl ?? source.source_root,
			userId: input.userId,
			sourceId: source.id,
			...(input.expectedPackageScope !== undefined
				? { expectedPackageScope: input.expectedPackageScope }
				: {}),
		})
		return {
			commit: input.commit,
			ok: checks.ok,
			results: checks.results,
		}
	}

	async publishFromExternalRef(input: {
		sessionId: string
		sourceId: string
		userId: OwnerId
		newCommit: string
		expectedHead?: string | null
		allowForce?: boolean
		destructiveOverwriteConfirmed?: boolean
		baseUrl?: string
		rebuildPackageArtifacts?: boolean
		expectedPackageScope?: string
		allowLockedPublish?: boolean
		credentialNeedsApproved?: boolean
		requestedByUserId?: string | null
		deferBundleCheckToRebuild?: boolean
	}): Promise<RepoExternalPublishResult> {
		const source = await getEntitySourceById(this.env.APP_DB, input.sourceId)
		if (!source || source.user_id !== input.userId) {
			throw new Error('Repo source was not found for this user.')
		}
		const phaseTimings: PublishPhaseTimings = {}
		const { sourceRepo, publishClone } = await this.cloneExternalRefForPublish({
			source,
			commit: input.newCommit,
			expectedHead: input.expectedHead,
			phaseTimings,
		})
		const runId = crypto.randomUUID()
		const publishDir = publishClone.dir || externalPublishWorkspaceDir
		// Always collect a binary-safe snapshot before publish. Do not skip this
		// based on the pre-clone D1 row: a concurrent snapshot-failure revert can
		// clear published_commit so publishFromExternalRef still finalizes, and
		// falling back to UTF-8 checks.sourceFiles would corrupt PNG magic.
		// Checks still walk the workspace via UTF-8 readFile for validation only.
		const snapshotFiles = await publishClone.collectFiles()
		const publishResult = await publishExternalRefSource({
			env: this.env,
			sourceId: source.id,
			userId: input.userId,
			newCommit: input.newCommit,
			runId,
			isFastForward: async ({ previousCommit }) =>
				await publishClone.isAncestorCommit({
					ancestor: previousCommit,
					descendant: input.newCommit,
				}),
			allowForce: input.allowForce,
			destructiveOverwriteConfirmed: input.destructiveOverwriteConfirmed,
			workspace: publishClone.workspace,
			files: snapshotFiles,
			baseUrl: input.baseUrl ?? source.source_root,
			manifestPath: resolveRepoWorkspacePath(source.manifest_path, publishDir),
			sourceRoot: resolveRepoWorkspacePath(
				source.source_root || publishDir,
				publishDir,
			),
			rebuildPackageArtifacts: input.rebuildPackageArtifacts ?? true,
			expectedPackageScope: input.expectedPackageScope,
			allowLockedPublish: input.allowLockedPublish,
			credentialNeedsApproved: input.credentialNeedsApproved,
			requestedByUserId: input.requestedByUserId,
			phaseTimings,
			...(input.deferBundleCheckToRebuild
				? { deferBundleCheckToRebuild: true }
				: {}),
		})
		if (publishResult.status === 'already_published') {
			// D1 stays a no-op (overlapping inline + durable escalation). Rewrite
			// the KV snapshot only when it is missing or the cloned HEAD files
			// differ, so a prior finalize that tagged this commit with stale
			// files cannot keep winning artifact rebuilds.
			let forceArtifactRebuild = false
			try {
				if (
					publishResult.published_commit &&
					hasPublishedRuntimeArtifacts(this.env)
				) {
					const files = snapshotFiles
					if (typeof files[source.manifest_path] === 'string') {
						const existingSnapshot = await loadPublishedSourceSnapshot({
							env: this.env,
							userId: input.userId,
							source: {
								...source,
								published_commit: publishResult.published_commit,
							},
						})
						if (!publishedSourceSnapshotFilesMatch(existingSnapshot, files)) {
							// Missing snapshot is the D1-finalize vs KV-write
							// overlap: keep live artifacts and do not force.
							// Mismatch means this commit was tagged with stale
							// files. Rewrite the snapshot (rebuild reads it)
							// and stamp invalidateArtifactsBefore so a later
							// already_published cannot skip leftovers. Do not
							// delete rows: that would take invoke offline.
							const snapshotExisted = existingSnapshot?.files != null
							await writePublishedSourceSnapshot({
								env: this.env,
								source: {
									...source,
									published_commit: publishResult.published_commit,
								},
								files,
								invalidateExistingArtifacts: snapshotExisted,
							})
							forceArtifactRebuild = snapshotExisted
						}
					}
				}
			} catch (error) {
				Sentry.captureException(error, {
					tags: {
						scope:
							'repo.publishFromExternalRef.refresh-already-published-snapshot',
					},
					extra: {
						sourceId: source.id,
						commit: input.newCommit,
					},
				})
				console.warn('already_published snapshot refresh failed', {
					scope:
						'repo.publishFromExternalRef.refresh-already-published-snapshot',
					sourceId: source.id,
					commit: input.newCommit,
					error: getErrorMessage(error),
				})
				throw error
			}
			return attachPublishPhaseTimings(
				{
					...publishResult,
					force_artifact_rebuild: forceArtifactRebuild,
				},
				phaseTimings,
			)
		} else if (publishResult.status === 'published') {
			try {
				const sourceWriteAccess = await ensureArtifactRepoRemote({
					repo: sourceRepo,
					scope: 'write',
					pendingReconcile: buildPendingExternalReconcile(
						this.env.APP_DB,
						source,
					),
				})
				await attachPublishGitNoteBestEffort({
					filesystem: publishClone.filesystem,
					dir: publishDir,
					commitOid: input.newCommit,
					remote: sourceWriteAccess.remote,
					token: sourceWriteAccess.token,
					remoteName: 'origin',
					note: buildPublishGitNote({
						publishedBy: 'external_push',
						source,
						commit: input.newCommit,
						sessionId: input.sessionId,
						previousPublishedCommit: publishResult.previous_commit,
						checks: {
							runId,
							treeHash: null,
							checkedAt: new Date().toISOString(),
							ok: true,
							results: publishResult.checks.map((entry) => ({
								kind: entry.kind,
								ok: entry.ok,
								message: entry.message,
							})),
						},
					}),
					scope: 'repo.publishFromExternalRef.publish-git-note',
				})
			} catch (error) {
				Sentry.captureException(error, {
					tags: { scope: 'repo.publishFromExternalRef.publish-git-note-setup' },
					extra: {
						sourceId: source.id,
						commit: input.newCommit,
					},
				})
				console.warn('publish_git_note setup failed', {
					scope: 'repo.publishFromExternalRef.publish-git-note-setup',
					sourceId: source.id,
					commit: input.newCommit,
					error: getErrorMessage(error),
				})
			}
		}
		return attachPublishPhaseTimings(publishResult, phaseTimings)
	}
}

export const RepoSession = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RepoSessionBase,
)

export function repoSessionRpc(env: Env, sessionId: string) {
	return createRepoSessionRpc(env, sessionId)
}

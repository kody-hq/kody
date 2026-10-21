import { type ArtifactBootstrapAccess } from './artifacts.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { repoSessionDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	type IsolatedArtifactRebuildOutcome,
	type IsolatedArtifactRebuildRequest,
} from './isolated-artifact-rebuild.ts'
import {
	type IsolatedCheckPhaseOutcome,
	type IsolatedCheckPhaseRequest,
} from './isolated-check-phases.ts'
import {
	type RepoSourceBootstrapResult,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSessionApplyEditsResult,
	type RepoSessionCheckRun,
	type RepoSessionCheckStatus,
	type RepoSessionDiscardResult,
	type RepoSessionEdit,
	type RepoExternalPublishResult,
	type RepoExternalRefCheckResult,
	type RepoSessionInfoResult,
	type RepoSessionPublishResult,
	type RepoSessionRebaseResult,
	type RepoSessionSearchResult,
	type RepoSessionTreeResult,
} from './types.ts'

export type RepoSessionRpc = {
	getEstimatedBytes: () => Promise<{ estimatedBytes: number }>
	openSession: (payload: {
		sessionId: string
		sourceId: string
		userId: string
		baseUrl: string
		conversationId?: string | null
		sourceRoot?: string | null
		defaultBranch?: string | null
	}) => Promise<RepoSessionInfoResult>
	getSessionInfo: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionInfoResult>
	discardSession: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionDiscardResult>
	purgeSession: (payload: {
		sessionId: string
		userId: string
	}) => Promise<{ ok: true; sessionId: string }>
	cleanupSessionBranch: (payload: {
		sessionId: string
		userId: string
		reason: 'expired' | 'abandoned' | 'source_deleted'
	}) => Promise<{
		ok: true
		sessionId: string
		branch: string
		branchDeleted: boolean
	}>
	readFile: (payload: {
		sessionId: string
		userId: string
		path: string
	}) => Promise<{ path: string; content: string | null }>
	writeFile: (payload: {
		sessionId: string
		userId: string
		path: string
		content: string
	}) => Promise<{ ok: true; path: string }>
	search: (payload: {
		sessionId: string
		userId: string
		pattern: string
		mode?: RepoSearchMode
		glob?: string | null
		path?: string | null
		caseSensitive?: boolean
		before?: number
		after?: number
		limit?: number
		outputMode?: RepoSearchOutputMode
	}) => Promise<RepoSessionSearchResult>
	tree: (payload: {
		sessionId: string
		userId: string
		path?: string | null
		maxDepth?: number
	}) => Promise<RepoSessionTreeResult>
	applyEdits: (payload: {
		sessionId: string
		userId: string
		edits: Array<RepoSessionEdit>
		dryRun?: boolean
		rollbackOnError?: boolean
	}) => Promise<RepoSessionApplyEditsResult>
	applyPatch: (payload: {
		sessionId: string
		userId: string
		patch: string
		dryRun?: boolean
	}) => Promise<RepoSessionApplyEditsResult>
	sessionStatus: (payload: {
		sessionId: string
		userId: string
	}) => Promise<unknown>
	sessionDiff: (payload: {
		sessionId: string
		userId: string
	}) => Promise<unknown>
	sessionLog: (payload: {
		sessionId: string
		userId: string
		depth?: number
	}) => Promise<unknown>
	sessionCommit: (payload: {
		sessionId: string
		userId: string
		message: string
	}) => Promise<{ oid: string; message: string }>
	restoreFiles: (payload: {
		sessionId: string
		userId: string
		paths: Array<string>
		commit?: string
	}) => Promise<{ commit: string; restored: Array<string> }>
	bootstrapSource: (payload: {
		sessionId: string
		sourceId: string
		userId: string
		edits: Array<Exclude<RepoSessionEdit, { kind: 'delete' | 'move' }>>
		bootstrapAccess?: ArtifactBootstrapAccess | null
		existingHeadCommit?: string
		requirePackageDocs?: boolean
		runPublishChecks?: boolean
		expectedPackageScope?: string
	}) => Promise<RepoSourceBootstrapResult>
	runChecks: (payload: {
		sessionId: string
		userId: string
		expectedPackageScope?: string
		requirePackageDocs?: boolean
	}) => Promise<RepoSessionCheckRun>
	runIsolatedCheckPhase: (
		payload: IsolatedCheckPhaseRequest,
	) => Promise<IsolatedCheckPhaseOutcome>
	getCheckStatus: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionCheckStatus>
	/**
	 * Trusted opt-out: stamp ok check-status for the current tree without
	 * running validators so publishSession can proceed without force.
	 */
	acceptCurrentTreeForPublish: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionCheckStatus>
	listPublishedPackageArtifactTargets: (payload: {
		sessionId?: string
		sourceId?: string
		userId: string
	}) => Promise<Array<PublishedPackageArtifactBuildTarget>>
	stagePublishedPackageArtifactRebuild: (payload: {
		sessionId?: string
		sourceId?: string
		userId: string
		publishedCommit: string
	}) => Promise<{
		stagingKey: string
	}>
	runIsolatedArtifactRebuild: (
		payload: IsolatedArtifactRebuildRequest,
	) => Promise<IsolatedArtifactRebuildOutcome>
	rebuildPublishedPackageArtifact: (payload: {
		sessionId?: string
		sourceId?: string
		userId: string
		publishedCommit: string
		target: PublishedPackageArtifactBuildTarget
		baseUrl?: string
	}) => Promise<{
		ok: true
		target: PublishedPackageArtifactBuildTarget
		kvKey: string | null
	}>
	rebaseSession: (payload: {
		sessionId: string
		userId: string
	}) => Promise<RepoSessionRebaseResult>
	publishSession: (payload: {
		sessionId: string
		userId: string
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
		expectedHeadCommit?: string
	}) => Promise<RepoSessionPublishResult>
	publishFromExternalRef: (payload: {
		sessionId: string
		sourceId: string
		userId: string
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
	}) => Promise<RepoExternalPublishResult>
	checkExternalRef: (payload: {
		sourceId: string
		userId: string
		commit: string
		baseUrl?: string
		expectedPackageScope?: string
	}) => Promise<RepoExternalRefCheckResult>
}

export function repoSessionRpc(env: Env, sessionId: string): RepoSessionRpc {
	const namespace = (
		env as Env & { REPO_SESSION?: DurableObjectNamespace | undefined }
	).REPO_SESSION
	if (!namespace) {
		throw new Error('REPO_SESSION binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(repoSessionDurableObjectName(sessionId)),
	) as unknown as RepoSessionRpc
}

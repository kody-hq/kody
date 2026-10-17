import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { type CredentialNeedsApprovalRequired } from '#worker/credentials/credential-needs-approval.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'

export const entityKindValues = ['package', 'repo'] as const
export type EntityKind = (typeof entityKindValues)[number]

export const entitySourceRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	entity_kind: z.enum(entityKindValues),
	entity_id: z.string(),
	repo_id: z.string(),
	published_commit: z.string().nullable(),
	indexed_commit: z.string().nullable(),
	manifest_path: z.string(),
	source_root: z.string(),
	last_external_check_at: z.string().nullable(),
	external_check_until: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export type EntitySourceRow = Omit<
	z.infer<typeof entitySourceRowSchema>,
	'user_id'
> & {
	/** Owner id bytes as stored. Storage keys use this value untrimmed. */
	user_id: OwnerId
}

export const repoSessionStatusValues = [
	'active',
	'published',
	'discarded',
] as const

export type RepoSessionStatus = (typeof repoSessionStatusValues)[number]

export const repoSessionRowSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	source_id: z.string(),
	source_repo_id: z.string(),
	session_branch: z.string(),
	source_branch: z.string(),
	base_commit: z.string(),
	source_root: z.string(),
	conversation_id: z.string().nullable(),
	status: z.enum(repoSessionStatusValues),
	expires_at: z.string().nullable(),
	last_checkpoint_at: z.string().nullable(),
	last_checkpoint_commit: z.string().nullable(),
	last_check_run_id: z.string().nullable(),
	last_check_tree_hash: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export type RepoSessionRow = Omit<
	z.infer<typeof repoSessionRowSchema>,
	'user_id'
> & {
	/** Owner id bytes as stored. RepoSessionIndex is named with this value untrimmed. */
	user_id: OwnerId
}

export const repoContextSchema = z.object({
	sourceId: z.string().nullable().optional(),
	repoId: z.string().nullable().optional(),
	sessionId: z.string().nullable().optional(),
	baseCommit: z.string().nullable().optional(),
	manifestPath: z.string().nullable().optional(),
	sourceRoot: z.string().nullable().optional(),
	publishedCommit: z.string().nullable().optional(),
	entityKind: z.enum(entityKindValues).nullable().optional(),
	entityId: z.string().nullable().optional(),
})

export type RepoContext = z.infer<typeof repoContextSchema>

export type SearchProjection = {
	title: string
	description: string
	keywords: Array<string>
	searchText: string | null
}

export type RepoSearchMode = 'literal' | 'regex'
export type RepoSearchOutputMode = 'content' | 'files'

export type RepoSearchMatch = {
	line: number
	column: number
	match: string
	lineText: string
	beforeLines: Array<string>
	afterLines: Array<string>
}

export type RepoSearchFileMatch = {
	path: string
	matches: Array<RepoSearchMatch>
}

export type RepoSessionSearchResult = {
	files: Array<RepoSearchFileMatch>
	totalFiles: number
	totalMatches: number
	outputMode: RepoSearchOutputMode
	truncated: boolean
}

export type RepoSessionInfo = {
	id: string
	sourceId: string
	sourceRoot: string
	baseCommit: string
	sessionBranch: string
	sourceBranch: string
	conversationId: string | null
	lastCheckpointCommit: string | null
	lastCheckRunId: string | null
	lastCheckTreeHash: string | null
	expiresAt: string | null
	createdAt: string
	updatedAt: string
	publishedCommit: string | null
	manifestPath: string
	entityType: EntityKind
}

export type RepoSessionDiscardResult = {
	ok: true
	sessionId: string
	deleted: boolean
}

export type RepoSessionInfoResult = {
	id: string
	source_id: string
	source_root: string
	base_commit: string
	session_branch: string
	source_branch: string
	conversation_id: string | null
	last_checkpoint_commit: string | null
	last_check_run_id: string | null
	last_check_tree_hash: string | null
	expires_at: string | null
	created_at: string
	updated_at: string
	published_commit: string | null
	manifest_path: string
	entity_type: EntityKind
}

export type RepoSessionTreeResult = {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<RepoSessionTreeResult>
}

export type RepoSessionReplaceOptions = {
	caseSensitive?: boolean
	regex?: boolean
	wholeWord?: boolean
	contextBefore?: number
	contextAfter?: number
	maxMatches?: number
}

export type RepoSessionWriteJsonOptions = {
	spaces?: number
}

export type RepoSessionWriteEdit = {
	kind: 'write'
	path: string
	content: string
}

export type RepoSessionReplaceEdit = {
	kind: 'replace'
	path: string
	search: string
	replacement?: string
	options?: RepoSessionReplaceOptions
}

export type RepoSessionWriteJsonEdit = {
	kind: 'writeJson'
	path: string
	value: unknown
	options?: RepoSessionWriteJsonOptions
}

export type RepoSessionDeleteEdit = {
	kind: 'delete'
	path: string
}

export type RepoSessionMoveEdit = {
	kind: 'move'
	path: string
	to: string
}

export type RepoSessionEdit =
	| RepoSessionWriteEdit
	| RepoSessionReplaceEdit
	| RepoSessionWriteJsonEdit
	| RepoSessionDeleteEdit
	| RepoSessionMoveEdit

export type RepoSessionApplyEditsResult = {
	dryRun: boolean
	totalChanged: number
	edits: Array<{
		path: string
		changed: boolean
		content: string
		diff: string
	}>
}

export type RepoSessionCheckStatus = {
	runId: string | null
	treeHash: string | null
	checkedAt: string | null
	ok: boolean | null
	results: Array<{
		kind:
			| 'manifest'
			| 'docs'
			| 'skills'
			| 'dependencies'
			| 'bundle'
			| 'typecheck'
			| 'lint'
			| 'credentials'
			| 'smoke'
		ok: boolean
		message: string
	}> | null
}

export type RepoSessionCheckRun = {
	ok: boolean
	results: Array<{
		kind:
			| 'manifest'
			| 'docs'
			| 'skills'
			| 'dependencies'
			| 'bundle'
			| 'typecheck'
			| 'lint'
			| 'credentials'
			| 'smoke'
		ok: boolean
		message: string
	}>
	/** Null when package.json itself failed to parse or was missing. */
	manifest: AuthoredPackageJson | null
	runId: string
	treeHash: string
	checkedAt: string
}

export type RepoSessionPublishResult =
	| {
			status: 'ok'
			sessionId: string
			publishedCommit: string
			message: string
	  }
	| {
			status: 'checks_outdated'
			sessionId: string
			message: string
			publishedCommit: null
	  }
	| {
			status: 'base_moved'
			sessionId: string
			message: string
			publishedCommit: null
			sessionBaseCommit: string
			currentPublishedCommit: string | null
			repairHint: 'repoRebaseSession'
	  }
	| {
			status: 'locked'
			sessionId: string
			message: string
			publishedCommit: null
			pendingCommit: string
			currentPublishedCommit: string | null
			packageId: string
			packageName: string
			credentialNotice: string | null
	  }
	| {
			status: 'approval_required'
			sessionId: string
			message: string
			publishedCommit: null
			currentPublishedCommit: string | null
			approval: CredentialNeedsApprovalRequired
			credentialNotice: string | null
	  }

export type RepoExternalPublishResult =
	| {
			status: 'already_published'
			published_commit: string | null
			/**
			 * True when already_published rewrote a missing or mismatched source
			 * snapshot. Callers must force artifact rebuild so same-commit leftovers
			 * cannot keep serving. Omit / false when the snapshot already matches.
			 */
			force_artifact_rebuild?: boolean
			phase_timings?: PublishPhaseTimings
	  }
	| {
			status: 'not_fast_forward'
			previous_commit: string
			published_commit: string
			message: string
	  }
	| {
			status: 'checks_failed'
			failed_checks: NonNullable<RepoSessionCheckStatus['results']>
			/** Null when package.json itself failed to parse or was missing. */
			manifest: AuthoredPackageJson | null
			run_id: string
	  }
	| {
			status: 'published'
			previous_commit: string | null
			published_commit: string
			manifest: AuthoredPackageJson
			checks: NonNullable<RepoSessionCheckStatus['results']>
			phase_timings?: PublishPhaseTimings
	  }
	| {
			status: 'locked'
			previous_commit: string | null
			pending_commit: string
			message: string
			packageId: string
			packageName: string
			/** Names stale static dependents still reading kept or removed mounts. */
			secret_mount_compat?: string | null
	  }
	| {
			status: 'approval_required'
			previous_commit: string | null
			pending_commit: string
			message: string
			approval: CredentialNeedsApprovalRequired
			secret_mount_compat?: string | null
	  }

export type RepoSourceBootstrapResult = {
	sessionId: string
	publishedCommit: string
	message: string
	/**
	 * Workspace tree after bootstrap. Required for dest-HEAD first publish so
	 * the published snapshot is the forked repo plus overlays, not just the
	 * rewritten files passed into sync.
	 */
	files?: Record<string, string>
	serverTiming?: Array<ServerTimingEntry>
}

export type RepoSessionRebaseResult = {
	ok: true
	sessionId: string
	baseCommit: string
	headCommit: string | null
	merged: boolean
}

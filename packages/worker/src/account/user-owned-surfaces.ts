export type UserOwnedDurableObjectSurface = {
	id:
		| 'job_manager'
		| 'storage_runner'
		| 'repo_session'
		| 'mcp_client_hub'
		| 'package_realtime_session'
		| 'run_log'
		| 'user_meter'
		| 'stripe_plan_refresh'
		| 'mailbox'
		| 'repo_session_index'
		| 'mcp'
		| 'execution_context_session'
	binding: string
	/** Result key used in AccountDeletionResult.clearedDurableObjects when purged */
	deletionResultKey: string | null
	export: 'include' | 'exclude'
	excludeReason?: string
	notes?: string
}

/**
 * Where the D1 rows that own a vector surface live. `app_db` surfaces are
 * enumerated with `SELECT id FROM {table} WHERE user_id = ?` against APP_DB;
 * `jobs_rpc` rows live in the jobs worker's dedicated D1 (ADR 0016) and are
 * enumerated through the JOBS service binding (`listJobIdsForUser`). APP_DB
 * has no `jobs` table since migration 0010.
 */
export type UserOwnedVectorizeSource =
	| { kind: 'app_db'; table: 'mcp_memories' | 'saved_packages' }
	| { kind: 'jobs_rpc' }

export type UserOwnedVectorizeSurface = {
	id: 'memory' | 'job' | 'saved_package'
	source: UserOwnedVectorizeSource
	/** Exported as derivedData.vectorize note; never exported as vectors */
	export: 'rebuild_from_d1'
}

export type UserOwnedKvKeyScheme = {
	id:
		| 'published_bundle_artifact_kv_key'
		| 'source_snapshot'
		| 'source_manifest_snapshot'
		| 'community_snapshot'
		| 'community_icon_derived_cache'
		| 'identity_icon_derived_cache'
		| 'usage_rollup_derived_cache'
		| 'artifact_head_derived_cache'
		| 'package_skills_index'
		| 'webhook_dispatch_payload'
		| 'package_codemod_revert'
		| 'mcp_oauth_refresh_family_snapshot'
		| 'mcp_oauth_refresh_family_replay'
	binding: 'BUNDLE_ARTIFACTS_KV'
	sourceTable?: string
	sourceColumn?: string
	prefixTemplate?: string
	retention?: string
	notes?: string
}

export type UserOwnedR2Surface = {
	id:
		| 'email_raw_mime'
		| 'email_attachment_storage_key'
		| 'community_icon'
		| 'identity_icon'
		| 'user_avatar'
		| 'org_transfer_backup'
	sourceTable: string
	sourceColumn?: string
	keyTemplate?: string
	notes?: string
} & (
	| { binding: 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS'; export: 'chunked_bytes' }
	| { binding: 'OPERATOR_BACKUPS'; export: 'exclude'; excludeReason: string }
)

export type UserOwnedWorkflowSurface = {
	id: 'dynamic_callable_workflow'
	binding: 'DYNAMIC_CALLABLE_WORKFLOWS'
	retention: string
	notes: string
}

export type UserOwnedArtifactSurface = {
	id: 'entity_sources'
	sourceTable: string
	repoColumn: string
	notes: string
}

export const accountUserOwnedDurableObjectSurfaces: ReadonlyArray<UserOwnedDurableObjectSurface> =
	[
		{
			id: 'job_manager',
			binding: 'JOBS',
			deletionResultKey: 'jobManagers',
			export: 'include',
			notes:
				'Job manager state lives in the jobs worker (ADR 0016) and is reached through the JOBS service binding; it is included in account export.',
		},
		{
			id: 'storage_runner',
			binding: 'STORAGE_RUNNER',
			deletionResultKey: 'storageRunners',
			export: 'include',
		},
		{
			id: 'repo_session',
			binding: 'REPO_SESSION',
			deletionResultKey: 'repoSessions',
			export: 'exclude',
			excludeReason:
				'Ephemeral editing workspace, including REPO_SESSION_BLOBS spill purged with the session Durable Object. Canonical repo-backed source is exported as Artifacts repo pointers via entity_sources; session catalog metadata is exported from RepoSessionIndex.',
		},
		{
			id: 'mcp_client_hub',
			binding: 'MCP_CLIENT_HUB',
			deletionResultKey: 'mcpClientHubs',
			export: 'exclude',
			excludeReason:
				'MCP client hub state can include OAuth tokens and SDK registrations that are non-portable; it is purged during account deletion instead of exported.',
		},
		{
			id: 'package_realtime_session',
			binding: 'PACKAGE_REALTIME_SESSION',
			deletionResultKey: 'packageRealtimeSessions',
			export: 'exclude',
			excludeReason:
				'Ephemeral live websocket/session state. Durable app storage is exported through StorageRunner buckets.',
		},
		{
			id: 'run_log',
			binding: 'RUN_LOG',
			deletionResultKey: 'runLogs',
			export: 'include',
			notes:
				'Per-user RunLog DO (RUN_LOG binding; idFromName(userId)). Sole runtime authority for pruned run history (runs + run_logs), the keyed package-invocation idempotency ledger, and dedicated state: workflow_projections (binding_name, typically DYNAMIC_CALLABLE_WORKFLOWS; terminal rows age-prune after 90 days), job_run_observability (terminal outcomes/counters; D1 jobs keeps schedule + last_run_at/last_run_status for retention only), package_run_successes, activation_milestones, and content-free skill_reads (retained until account deletion, exported after activation milestones). There are no D1 tables workflow_runs, user_package_run_successes, or user_activation_milestones (pre-drop Time Travel bookmark 0000116d-000000d2-000050bd-c7ecd5892a189df7cda145af746bc9c9 on database 8c1014d1-6b41-4695-a0a2-159071f0f919). Run history self-prunes (~30 days / 2,000 runs); job/activation dedicated tables are never pruned. Account deletion clearAll deletes every DO table and reinitializes schema. Account export pages all tables through the run_records section (runs first, then ledger, then dedicated phases).',
		},
		{
			id: 'user_meter',
			binding: 'USER_METER',
			deletionResultKey: 'userMeters',
			export: 'include',
			notes:
				'Per-user daily entitlement counters, storage-byte state, deletion-fence/write-lease state, and inbound MCP OAuth last-used stamps (one DO per stable userId). Daily counters and storage bytes are authoritative in UserMeter; users has no d1_storage_bytes mirror columns, and the reconcile lane sweeps users by stable_user_id keyset from the platform-owned d1_storage_reconcile_cursor row. UserMeter is the sole lease authority: all callers (including email paths) supply USER_METER via env; acquireWriteLease writes to the DO only and countActiveWriteLeases is a direct DO COUNT (no paging). There is no D1 account_write_leases table; D1 users.deleting_at remains the permanent point gate and account_write_lease_repairs remains the admin repair audit log. inbound_mcp_connection_last_used is keyed by inbound OAuth clientId and updated from successful /mcp bearer validation (5-minute debounce); Account → Connections joins it as last-used, and revoke deletes the row. Self-prunes stale UTC-day rows inside the DO rather than through a retention cron lane; account deletion purge clears counters, storage-byte state, write leases, and inbound last-used while preserving an existing deleting tombstone during cleanup, then origin drops that tombstone after the D1 user row is deleted so the purged object keeps no state; account export pages counters through the user_meter section via exportCounters and includes authoritative storageBytesState, sanitized deletionState without raw lease token/holder, and inboundConnectionLastUsed on the first page only.',
		},
		{
			id: 'stripe_plan_refresh',
			binding: 'STRIPE_PLAN_REFRESH',
			deletionResultKey: 'stripePlanRefreshes',
			export: 'exclude',
			excludeReason:
				'Ephemeral one-shot Stripe reconciliation alarm state. Billing columns remain canonical in D1 and are included in the users export.',
			notes:
				'One alarm object per stable userId. Account deletion cancels the alarm and clears its stored owner id.',
		},
		{
			id: 'mailbox',
			binding: 'MAILBOX',
			deletionResultKey: 'mailboxes',
			export: 'include',
			notes:
				'Per-user authoritative email metadata and R2-reference inventory (MAILBOX binding; idFromName(userId)). Account export pages the sole USER email graph through exportMailbox. Account deletion lists Mailbox blob references before deleting R2 objects and purging the DO; D1 retains only thin provider, due-work, alert, and configuration rows.',
		},
		{
			id: 'repo_session_index',
			binding: 'REPO_SESSION_INDEX',
			deletionResultKey: 'repoSessionIndexes',
			export: 'include',
			notes:
				'Per-user repo session catalog (REPO_SESSION_INDEX binding; idFromName(userId)). Authority for session rows, active counts, conversation resume, export, and deletion inventory. Workspace bytes stay in per-session RepoSession DOs. D1 keeps only the thin repo_session_due_owners hint plus the storage-bucket inventory cursor.',
		},
		{
			id: 'mcp',
			binding: 'MCP',
			deletionResultKey: 'mcpAgentSessions',
			export: 'exclude',
			excludeReason:
				'Session-keyed by the MCP SDK and not globally enumerable; durable user data is carried by D1 and user-scoped stores instead.',
			notes:
				'Session DO ids are indexed by user in mcp_agent_sessions and purged during account deletion.',
		},
		{
			id: 'execution_context_session',
			binding: 'EXECUTION_CONTEXT_SESSION',
			deletionResultKey: null,
			export: 'exclude',
			excludeReason:
				'Execution context connection sessions store nothing today: every connection is refused. Registrations, sharing, and chains live in D1 and follow the D1 account data targets.',
			notes:
				'Platform-owned ExecutionContextSessionV1. When sessions start keeping run history it is bounded (30 days, 1,000 runs per context) and this entry declares how it is exported and purged.',
		},
	] as const

export const accountUserOwnedVectorizeSurfaces: ReadonlyArray<UserOwnedVectorizeSurface> =
	[
		{
			id: 'memory',
			source: { kind: 'app_db', table: 'mcp_memories' },
			export: 'rebuild_from_d1',
		},
		{ id: 'job', source: { kind: 'jobs_rpc' }, export: 'rebuild_from_d1' },
		{
			id: 'saved_package',
			source: { kind: 'app_db', table: 'saved_packages' },
			export: 'rebuild_from_d1',
		},
	] as const

export const accountUserOwnedKvKeySchemes: ReadonlyArray<UserOwnedKvKeyScheme> =
	[
		{
			id: 'published_bundle_artifact_kv_key',
			binding: 'BUNDLE_ARTIFACTS_KV',
			sourceTable: 'published_bundle_artifacts',
			sourceColumn: 'kv_key',
			prefixTemplate: 'bundle-artifact:v1:',
		},
		{
			id: 'source_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'source-snapshot:v1:{sourceId}:',
		},
		{
			id: 'source_manifest_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'source-manifest-snapshot:v1:{sourceId}:',
		},
		{
			id: 'community_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'community-snapshot:v1:',
		},
		{
			id: 'community_icon_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:community-icon:v3:{listingId}:',
			notes:
				'Derived cache key from derivedCacheKeyPrefix + buildCommunityIconCacheKey. Account deletion also prefixes historical community-icon:v1 and community-icon:v2 keys.',
		},
		{
			id: 'identity_icon_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:identity-icon:v1:{repoId}:',
			notes:
				'Derived cache key from derivedCacheKeyPrefix + buildIdentityIconCacheKey. Account deletion prefixes every entity_sources.repo_id.',
		},
		{
			id: 'usage_rollup_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:usage-rollups:user:{userId}:',
			retention:
				'Expires through the KV expirationTtl written by the cachified adapter; the configured retention is five minutes.',
			notes:
				'Short-lived derived admin read model. Immediate account-deletion cleanup is optional because KV enforces the TTL.',
		},
		{
			id: 'artifact_head_derived_cache',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:artifact-head:v1:{namespace}:{repoId}',
			retention:
				'Expires through the KV expirationTtl written by the cachified adapter; retention is at most 65 minutes (5 minute TTL plus 1 hour stale-while-revalidate).',
			notes:
				'Default-branch HEAD of an Artifacts repo for package pages (buildArtifactSourceHeadCacheKey). Holds a branch name and commit hash only. Immediate account-deletion cleanup is optional because KV enforces the TTL and the repo id stops resolving once entity_sources is gone.',
		},
		{
			id: 'package_skills_index',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'package-skills-index:v1:{userId}:{packageId}:',
			notes: 'Deleted by deleteAllPackageSkillsIndexEntriesForUser.',
		},
		{
			id: 'webhook_dispatch_payload',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'webhook-dispatch-payload:v1:{userId}:',
			retention:
				'Expires through the KV expirationTtl written at store time; retention is 24 hours.',
			notes:
				'Short-lived ack-mode webhook body spill so Cloudflare Queue messages stay under 128 KB. Immediate account-deletion cleanup is optional because KV enforces the TTL. The consumer deletes the key after a terminal delivery.',
		},
		{
			id: 'package_codemod_revert',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'package-codemod-revert:{userId}:',
			retention: 'Expires through the KV expirationTtl written at apply time.',
			notes: 'Account deletion prefix-deletes the user namespace.',
		},
		{
			id: 'mcp_oauth_refresh_family_snapshot',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:mcp-oauth-refresh-family:{userId}:',
			retention:
				'Expires through the KV expirationTtl written at refresh time (two hours).',
			notes:
				'Encrypted MCP OAuth token snapshot. Account deletion prefix-deletes the user namespace; the TTL backstops a refresh racing deletion.',
		},
		{
			id: 'mcp_oauth_refresh_family_replay',
			binding: 'BUNDLE_ARTIFACTS_KV',
			prefixTemplate: 'derived-cache:v1:mcp-oauth-refresh-replay:{userId}:',
			retention:
				'Expires through the KV expirationTtl written at refresh time (one hour).',
			notes:
				'Encrypted MCP OAuth token replay copy. Account deletion prefix-deletes the user namespace; the TTL backstops a refresh racing deletion.',
		},
	] as const

export const accountUserOwnedR2Surfaces: ReadonlyArray<UserOwnedR2Surface> = [
	{
		id: 'email_raw_mime',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'Mailbox.email_messages',
		sourceColumn: 'id',
		keyTemplate: 'email-raw:v1:{userId}/{messageId}',
		export: 'chunked_bytes',
		notes:
			'Authoritative references come from Mailbox.listBlobReferences; canonical key generated by emailRawMimeKey.',
	},
	{
		id: 'email_attachment_storage_key',
		binding: 'EMAIL_BLOBS',
		sourceTable: 'Mailbox.email_attachments',
		sourceColumn: 'storage_key',
		keyTemplate: 'email-attachment:v1:{userId}/{messageId}/{attachmentId}',
		export: 'chunked_bytes',
		notes:
			'Authoritative owner-safe references come from Mailbox.listBlobReferences.',
	},
	{
		id: 'community_icon',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'community_listings',
		keyTemplate: 'community-icon:v3/{listingId}/{commit}/asset',
		export: 'chunked_bytes',
		notes:
			'Current fitted WebP derivative. Account deletion also removes historical community-icon:v1 and community-icon:v2 prefixes.',
	},
	{
		id: 'identity_icon',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'entity_sources',
		sourceColumn: 'repo_id',
		keyTemplate: 'identity-icon:v1/{repoId}/{commit}/asset',
		export: 'chunked_bytes',
		notes:
			'Fitted WebP/PNG/JPEG derivative of .kody/icon (and aliases). Account deletion prefix-deletes every entity_sources.repo_id.',
	},
	{
		id: 'user_avatar',
		binding: 'COMMUNITY_ASSETS',
		sourceTable: 'users',
		sourceColumn: 'avatar_key',
		export: 'chunked_bytes',
	},
	{
		id: 'org_transfer_backup',
		binding: 'OPERATOR_BACKUPS',
		sourceTable: 'org_audit_events',
		keyTemplate:
			'org-resource-transfers/{fromOrgId}/{toOrgId}/{stamp}-{uuid}.json',
		export: 'exclude',
		excludeReason:
			'Operator rollback snapshot of rows the owner already exports from D1; values stay ciphertext.',
		notes:
			'Written by adminOrgResourceTransfer apply. Account deletion and org hard purge delete every backup naming the owner as source or target (deleteOrgTransferBackupsForOwner).',
	},
] as const

export const accountUserOwnedArtifactSurfaces: ReadonlyArray<UserOwnedArtifactSurface> =
	[
		{
			id: 'entity_sources',
			sourceTable: 'entity_sources',
			repoColumn: 'repo_id',
			notes:
				'Cloudflare Artifacts repos cleaned by cleanupAllUserArtifactRepos.',
		},
	] as const

export const accountUserOwnedWorkflowSurfaces: ReadonlyArray<UserOwnedWorkflowSurface> =
	[
		{
			id: 'dynamic_callable_workflow',
			binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
			retention:
				'Cloudflare retains finished instance params and step output for the 30-day successRetention/errorRetention set at create; there is no API to delete a finished instance early.',
			notes:
				'RunLog workflow_projections is the only per-user index. Account deletion terminates every active instance through cancelActiveWorkflowRunsForUser before clearing RunLog. Instance ids hash the owner stable id, so a later account never reattaches to a retained instance.',
		},
	] as const

const accountExportExcludedDurableObjectDisplayNames: Readonly<
	Record<
		'mcp' | 'repo_session' | 'package_realtime_session' | 'stripe_plan_refresh',
		string
	>
> = {
	mcp: 'MCP',
	repo_session: 'RepoSession',
	package_realtime_session: 'PackageRealtimeSession',
	stripe_plan_refresh: 'StripePlanRefresh',
} as const

export function getAccountExportExcludedDurableObjects(): Array<{
	name: string
	reason: string
}> {
	return (
		[
			'mcp',
			'repo_session',
			'package_realtime_session',
			'stripe_plan_refresh',
		] satisfies Array<
			keyof typeof accountExportExcludedDurableObjectDisplayNames
		>
	).map((id) => {
		const surface = accountUserOwnedDurableObjectSurfaces.find(
			(candidate) => candidate.id === id,
		)
		if (!surface || surface.export !== 'exclude' || !surface.excludeReason) {
			throw new Error(`Missing account export durable object exclusion: ${id}`)
		}
		return {
			name: accountExportExcludedDurableObjectDisplayNames[id],
			reason: surface.excludeReason,
		}
	})
}

export function getAccountDeletionDurableObjectResultKeys(): ReadonlyArray<string> {
	return accountUserOwnedDurableObjectSurfaces
		.map((surface) => surface.deletionResultKey)
		.filter((key): key is string => key !== null)
}

export function getAccountUserOwnedSurfaceCoverage(): {
	durableObjectIds: ReadonlySet<string>
	vectorizeIds: ReadonlySet<string>
	kvSchemeIds: ReadonlySet<string>
	r2SurfaceIds: ReadonlySet<string>
	artifactSurfaceIds: ReadonlySet<string>
	workflowSurfaceIds: ReadonlySet<string>
} {
	return {
		durableObjectIds: new Set(
			accountUserOwnedDurableObjectSurfaces.map((surface) => surface.id),
		),
		vectorizeIds: new Set(
			accountUserOwnedVectorizeSurfaces.map((surface) => surface.id),
		),
		kvSchemeIds: new Set(
			accountUserOwnedKvKeySchemes.map((scheme) => scheme.id),
		),
		r2SurfaceIds: new Set(
			accountUserOwnedR2Surfaces.map((surface) => surface.id),
		),
		artifactSurfaceIds: new Set(
			accountUserOwnedArtifactSurfaces.map((surface) => surface.id),
		),
		workflowSurfaceIds: new Set(
			accountUserOwnedWorkflowSurfaces.map((surface) => surface.id),
		),
	}
}

export type UserScopedDataTarget =
	| {
			kind: 'user_id'
			table: string
			/**
			 * When false, account deletion still clears the table by user_id, but
			 * account export skips the rows. Provide surface/reason so the export
			 * manifest documents the deliberate omission.
			 */
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| {
			kind: 'db_user_id'
			table: string
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	// Rows keyed by a `target` column holding the stringified database user id
	// (Epic Stack-style verifications: 2fa secrets etc).
	| { kind: 'db_user_target'; table: string }
	| {
			kind: 'user_columns'
			table: string
			columns: ReadonlyArray<string>
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| {
			kind: 'null_user_column'
			table: string
			matchColumn: string
			nullColumns: ReadonlyArray<string>
			includeInExport?: boolean
	  }
	| {
			kind: 'replace_user_column'
			table: string
			matchColumn: string
			setColumn: string
			value: string
	  }
	| {
			/**
			 * Rewrite a JSON text column that may embed the deleted user's id
			 * (for example filters_json.userIds). Deletion-only: export still
			 * reaches the table through other match columns when appropriate.
			 */
			kind: 'replace_user_id_in_json_column'
			table: string
			column: string
			value: string
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| { kind: 'bucket_parent'; table: string; parentTable: string }
	| {
			kind: 'community_listing_child'
			table: string
			listingColumn: string
			includeInExport?: boolean
			surface?: string
			reason?: string
	  }
	| { kind: 'mcp_memory_suppression' }
	/** Delete rows whose `org_id` is the purged organization. */
	| { kind: 'org_id'; table: string }
	/**
	 * Delete child rows whose parent belongs to the purged organization
	 * (`parentKey` references `parentTable.id`, parent has `org_id`).
	 */
	| {
			kind: 'org_via_parent'
			table: string
			parentTable: string
			parentKey: string
	  }

export const accountUserDataExcludedOwnerIds = [
	{
		ownerId: 'system:email',
		surface: 'system_email_inboxes',
		reason:
			'Operator-owned inbound mail for reserved platform locals is stored under the reserved system:email owner id. It is not a user account, must not be attributed to any user, and is excluded from per-user account deletion/export while system retention pruning bounds growth.',
	},
] as const

/**
 * D1 tables that are operator/platform owned by construction and have no
 * user-id ownership column. They are permanently outside account deletion and
 * export; listing them here keeps that disposition explicit in export manifests.
 */
export const accountOperatorOwnedD1Surfaces = [
	{
		table: 'system_email_threads',
		surface: 'system_email_threads',
		reason:
			'Dedicated operator-owned system email thread metadata is permanently stored in D1 and excluded from user account deletion/export.',
	},
	{
		table: 'system_email_messages',
		surface: 'system_email_messages',
		reason:
			'Dedicated operator-owned system email messages are permanently stored in D1 and excluded from user account deletion/export.',
	},
	{
		table: 'system_email_attachments',
		surface: 'system_email_attachments',
		reason:
			'Dedicated operator-owned system email attachment metadata is permanently stored in D1 and excluded from user account deletion/export.',
	},
	{
		table: 'system_email_delivery_events',
		surface: 'system_email_delivery_events',
		reason:
			'Dedicated operator-owned system email delivery events are permanently stored in D1 and excluded from user account deletion/export.',
	},
	{
		table: 'platform_oauth_apps',
		surface: 'platform_oauth_apps',
		reason:
			'Operator-provisioned built-in OAuth app registrations (global config like feature flags; no user data). Per-user connections and token secrets remain user-scoped and covered by their own targets.',
	},
	{
		table: 'platform_provider_marks',
		surface: 'platform_provider_marks',
		reason:
			'Operator-owned provider brand marks (global catalog like platform OAuth app logos; no user data). Saved integrations and MCP servers use these after an explicit upload and before auto-favicon.',
	},
	{
		table: 'repo_session_storage_bucket_cursor',
		surface: 'repo_session_storage_bucket_cursor',
		reason:
			'Platform-owned storage-bucket inventory cursor across RepoSessionIndex owners (one singleton row). Not user data; account deletion does not touch it.',
	},
] as const

/** Targets that account export should skip (deletion still covers them). */
export function isExcludedFromAccountExport(
	target: UserScopedDataTarget,
): boolean {
	return 'includeInExport' in target && target.includeInExport === false
}

/**
 * Documented D1 surfaces omitted from account export. Includes owner-id
 * exclusions plus targets marked includeInExport: false with surface/reason.
 */
export function getAccountExportExcludedD1Surfaces(): Array<{
	name: string
	reason: string
}> {
	const surfaces: Array<{ name: string; reason: string }> = [
		...accountUserDataExcludedOwnerIds.map((exclusion) => ({
			name: exclusion.surface,
			reason: exclusion.reason,
		})),
		...accountOperatorOwnedD1Surfaces.map((surface) => ({
			name: surface.surface,
			reason: surface.reason,
		})),
	]
	for (const target of accountUserDataTargets) {
		if (!isExcludedFromAccountExport(target)) continue
		if (
			'surface' in target &&
			'reason' in target &&
			typeof target.surface === 'string' &&
			typeof target.reason === 'string'
		) {
			surfaces.push({ name: target.surface, reason: target.reason })
		}
	}
	return surfaces
}

/**
 * Tables that are scoped by `user_id` (directly or transitively) and should
 * be included in per-user account operations. A cleanup-only reviewer target
 * can opt out of export so it does not disclose another user's content. The
 * list is intentionally explicit so adding a new user-scoped table requires a
 * deliberate update here and a corresponding deletion/export guardrail test
 * update.
 * Rows owned by accountUserDataExcludedOwnerIds are operator/platform data,
 * not user data; tests assert those owner ids stay deliberately excluded from
 * user account operations.
 *
 * Order matters for deletion: child tables come before parent tables so the
 * cascade is self-contained even on engines / configs where foreign-key
 * cascades are disabled. Tables with no `user_id` column (e.g. global mock
 * tables) are not represented.
 */

/**
 * Tables still present in D1 after their product surface is gone. Rows may be
 * purged while DROP TABLE waits for a later deploy. Deletion/export do not
 * inventory these leftovers. Empty when nothing is mid-drop.
 */
export const accountUserDataPendingDropTables = [] as const

export const accountUserDataTargets: ReadonlyArray<UserScopedDataTarget> = [
	{ kind: 'user_id', table: 'api_tokens' },
	{ kind: 'user_id', table: 'connection_profiles' },
	{ kind: 'user_id', table: 'mcp_event_subscriptions' },
	{ kind: 'user_id', table: 'cli_credential_bootstrap_codes' },
	{ kind: 'user_id', table: 'user_storage_buckets' },
	{ kind: 'user_id', table: 'usage_rollups' },
	{
		kind: 'user_columns',
		table: 'usage_rollups',
		columns: ['actor_user_id'],
	},
	{ kind: 'user_id', table: 'usage_attribution_daily' },
	{
		kind: 'user_columns',
		table: 'usage_attribution_daily',
		columns: ['actor_user_id'],
	},
	{ kind: 'user_id', table: 'usage_connection_daily' },
	{
		kind: 'user_columns',
		table: 'usage_connection_daily',
		columns: ['holder_user_id'],
	},
	{ kind: 'user_id', table: 'durable_object_duration_daily' },
	{
		kind: 'user_columns',
		table: 'durable_object_duration_daily',
		columns: ['actor_user_id'],
	},
	{ kind: 'user_id', table: 'access_cache' },
	{ kind: 'user_id', table: 'user_usage_campaigns' },
	{ kind: 'user_id', table: 'user_usage_campaign_sends' },
	{ kind: 'user_id', table: 'user_tips_email_opt_outs' },
	{ kind: 'user_id', table: 'credit_debit_progress' },
	// Grants the deleted admin made stay on recipients' ledgers for audit;
	// only the granter id is anonymized.
	{
		kind: 'replace_user_column',
		table: 'credit_ledger_entries',
		matchColumn: 'granted_by_user_id',
		setColumn: 'granted_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'user_id', table: 'credit_ledger_entries' },
	{ kind: 'user_id', table: 'credit_wallets' },
	{ kind: 'user_id', table: 'billing_promo_claims' },
	{
		kind: 'user_columns',
		table: 'referrals',
		columns: ['referrer_stable_user_id', 'referee_stable_user_id'],
	},
	{ kind: 'user_id', table: 'feature_flag_exposure_rollups' },
	{ kind: 'user_id', table: 'agent_package_conversation_uses' },
	// Per-package codemod outcomes belong to the package owner. Delete before
	// anonymizing run attribution so orphaned items do not outlive the user.
	{ kind: 'user_id', table: 'package_codemod_run_items' },
	// Codemod runs are operator ledger rows: scope_user_id / initiated_by_user_id
	// are attribution only. Keep the run for audit and anonymize both columns
	// (matching community_bans.banned_by_user_id).
	{
		kind: 'replace_user_column',
		table: 'package_codemod_runs',
		matchColumn: 'scope_user_id',
		setColumn: 'scope_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'package_codemod_runs',
		matchColumn: 'initiated_by_user_id',
		setColumn: 'initiated_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_id_in_json_column',
		table: 'package_codemod_runs',
		column: 'filters_json',
		value: 'deleted-user',
		includeInExport: false,
		surface: 'package_codemod_runs_filters_json',
		reason:
			'Fleet/canary filter payloads may list the deleted user in userIds; deletion rewrites that id to deleted-user. Export reaches package_codemod_runs through scope/initiator columns instead.',
	},
	// A person's org grants of their personal credentials.
	{ kind: 'user_id', table: 'credential_org_grants' },
	// Inventory items are per-package results owned by the package owner; runs
	// are operator ledger rows whose initiator is attribution only.
	{ kind: 'user_id', table: 'credential_inventory_items' },
	{
		kind: 'replace_user_column',
		table: 'credential_inventory_runs',
		matchColumn: 'initiated_by_user_id',
		setColumn: 'initiated_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'mcp_memory_suppression' },
	{ kind: 'user_id', table: 'mcp_memories' },
	{ kind: 'user_id', table: 'mcp_user_server_instructions' },
	{ kind: 'user_id', table: 'mcp_agent_sessions' },
	{
		kind: 'replace_user_column',
		table: 'account_write_lease_repairs',
		matchColumn: 'target_user_id',
		setColumn: 'target_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'account_write_lease_repairs',
		matchColumn: 'repaired_by_user_id',
		setColumn: 'repaired_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'bucket_parent',
		table: 'secret_entries',
		parentTable: 'secret_buckets',
	},
	{ kind: 'user_id', table: 'secret_buckets' },
	{ kind: 'user_id', table: 'secret_provider_grants' },
	{ kind: 'user_id', table: 'secret_provider_bindings' },
	// Connections reference OAuth apps with ON DELETE RESTRICT, so delete
	// user_integrations before user_oauth_apps. Ciphertext columns are redacted
	// on export.
	{ kind: 'user_id', table: 'user_integrations' },
	{
		kind: 'replace_user_column',
		table: 'user_integrations',
		matchColumn: 'connected_by_user_id',
		setColumn: 'connected_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'user_id', table: 'user_oauth_apps' },
	{ kind: 'user_id', table: 'mcp_server_settings' },
	{
		kind: 'replace_user_column',
		table: 'mcp_server_settings',
		matchColumn: 'connected_by_user_id',
		setColumn: 'connected_by_user_id',
		value: 'deleted-user',
	},
	// Job rows live in the jobs worker's database (ADR 0016). Account deletion
	// reaches them through the JOBS service binding's purgeUser, and export
	// reads them through listJobsForUser.
	{ kind: 'user_id', table: 'published_bundle_artifacts' },
	{
		kind: 'user_id',
		table: 'repo_session_due_owners',
		includeInExport: false,
		surface: 'repo_session_due_owners',
		reason:
			'Operational RepoSessionIndex due-work coordination omitted from portable export; account deletion removes the owner hint.',
	},
	{ kind: 'user_id', table: 'user_repos' },
	{ kind: 'user_id', table: 'saved_packages' },
	// Approvals belong to the package owner org. Deleting a teammate who once
	// clicked Approve must not wipe the attestation; only owner purge does.
	{
		kind: 'user_columns',
		table: 'package_capability_approvals',
		columns: ['owner_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'package_capability_approvals',
		matchColumn: 'approved_by_user_id',
		setColumn: 'approved_by_user_id',
		value: 'deleted-user',
	},
	// Security audits are informational records on the owner's package. The
	// teammate who recorded one is attribution only.
	{
		kind: 'user_columns',
		table: 'package_security_audits',
		columns: ['owner_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'package_security_audits',
		matchColumn: 'recorded_by_user_id',
		setColumn: 'recorded_by_user_id',
		value: 'deleted-user',
	},
	// Custom hostname rows are owned by package_id / org_id (FK cascade). The
	// creator is attribution only: deleting that person anonymizes the column
	// without dropping a still-bound hostname.
	{
		kind: 'replace_user_column',
		table: 'package_app_custom_hostnames',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'package_approval_requests',
		columns: ['owner_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'package_approval_requests',
		matchColumn: 'requested_by_user_id',
		setColumn: 'requested_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'package_approval_requests',
		matchColumn: 'resolved_by_user_id',
		setColumn: 'resolved_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_id',
		table: 'saved_package_search_index_debt',
		includeInExport: false,
		surface: 'saved_package_search_index_debt',
		reason:
			'Operational search-index reconcile debt omitted from portable export; account deletion removes outstanding debt rows.',
	},
	{
		kind: 'user_id',
		table: 'vector_embed_fingerprints',
		includeInExport: false,
		surface: 'vector_embed_fingerprints',
		reason:
			'Derived Vectorize embed-text skip cache omitted from portable export; account deletion removes user-owned fingerprint rows. Builtin rows use the reserved __kody_builtin__ owner id.',
	},
	{ kind: 'user_id', table: 'entity_source_artifacts_push_subscriptions' },
	{ kind: 'user_id', table: 'entity_sources' },
	{
		kind: 'user_id',
		table: 'email_inbound_due_owners',
		includeInExport: false,
		surface: 'email_inbound_due_owners',
		reason:
			'Operational Mailbox due-work coordination omitted from portable export; account deletion removes the owner hint.',
	},
	{
		kind: 'user_id',
		table: 'email_outbound_provider_index_repair_owners',
		includeInExport: false,
		surface: 'email_outbound_provider_index_repair_owners',
		reason:
			'Aggregate provider-index repair health omitted from portable export; account deletion removes the owner health row.',
	},
	{
		kind: 'user_id',
		table: 'email_outbound_provider_index',
		includeInExport: false,
		surface: 'email_outbound_provider_index',
		reason:
			'Operational global provider→owner reverse lookup omitted from portable export. Mailbox rows retain provider ids, but no fleet-wide automatic rebuild is claimed; account deletion keeps explicit owner cleanup.',
	},
	{
		kind: 'db_user_id',
		table: 'transactional_email_delivery_index',
		includeInExport: false,
		surface: 'transactional_email_delivery_index',
		reason:
			'Operational Cloudflare message-id → user reverse lookup for signup/verify and additional-destination verification delivery webhooks omitted from portable export; account deletion removes the owner rows.',
	},
	{ kind: 'user_id', table: 'email_inbox_addresses' },
	{ kind: 'user_id', table: 'email_inboxes' },
	{ kind: 'user_id', table: 'email_sender_identities' },
	{ kind: 'user_id', table: 'email_sender_rules' },
	{ kind: 'user_id', table: 'webhook_endpoints' },
	{
		kind: 'replace_user_column',
		table: 'webhook_endpoints',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	// A deleted person's enablements end with them in every org; the org purge
	// removes their personal org's rows.
	{
		kind: 'user_columns',
		table: 'enablements',
		columns: ['enabler_user_id'],
	},
	// Their own default mappings and trigger overrides go with them; an org
	// default they last edited survives with the editor anonymized.
	{
		kind: 'user_columns',
		table: 'credential_mappings',
		columns: ['person_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'credential_mappings',
		matchColumn: 'updated_by_user_id',
		setColumn: 'updated_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'credential_mapping_proposals',
		columns: ['person_user_id'],
	},
	{
		kind: 'user_columns',
		table: 'approval_bundle_decisions',
		columns: ['decided_by_user_id'],
	},
	{
		kind: 'user_columns',
		table: 'approval_bundles',
		columns: ['person_user_id'],
	},
	{ kind: 'user_id', table: 'webhook_apply_destination_pending' },
	{ kind: 'user_id', table: 'webhook_apply_destination_grants' },
	{
		kind: 'user_columns',
		table: 'platform_feedback',
		columns: ['submitter_user_id'],
	},
	// Feedback is owned by its submitter. A reviewer relationship is cleanup
	// metadata only: deleting that reviewer anonymizes the surviving review,
	// but account export must not expose another user's feedback to the reviewer.
	{
		kind: 'null_user_column',
		table: 'platform_feedback',
		matchColumn: 'reviewed_by_user_id',
		nullColumns: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
		includeInExport: false,
	},
	{
		kind: 'community_listing_child',
		table: 'community_ratings',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_ratings_by_other_users',
		reason:
			'Ratings belong in the rating author export. Listing-owner deletion still cascades them, but listing-owner export must not disclose another user’s identity, score, or note.',
	},
	{ kind: 'user_id', table: 'community_ratings' },
	{
		kind: 'community_listing_child',
		table: 'community_activity_events',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_activity_by_other_users',
		reason:
			'Stored community activity belongs in the actor export. Listing-owner deletion still cascades it, but listing-owner export must not disclose another actor’s event type or timestamp.',
	},
	{
		kind: 'user_columns',
		table: 'community_activity_events',
		columns: ['actor_user_id'],
	},
	{
		kind: 'community_listing_child',
		table: 'community_forks',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_forks_by_other_users',
		reason:
			'Fork and adoption records belong in the forking user export. Listing-owner deletion still cascades them, but listing-owner export must not disclose another user’s identity or adoption note.',
	},
	{
		kind: 'user_columns',
		table: 'community_forks',
		columns: ['forker_user_id'],
	},
	// Follows belong to the follower org. Deleting the person who created one
	// anonymizes attribution and leaves the row for the rest of the org.
	{
		kind: 'replace_user_column',
		table: 'follows',
		matchColumn: 'creator_user_id',
		setColumn: 'creator_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'follows',
		columns: ['follower_org_id'],
		includeInExport: false,
		surface: 'follows_owned_by_org',
		reason:
			'Org hard purge deletes follows owned by the org. Account export uses creator_user_id so the creating person receives the row. Deleting a member anonymizes creator_user_id and leaves the org follow in place.',
	},
	{
		kind: 'community_listing_child',
		table: 'community_reports',
		listingColumn: 'listing_id',
		includeInExport: false,
		surface: 'community_listing_reports_by_other_users',
		reason:
			'Community reports are attributed moderation submissions. Listing-owner deletion still cascades them, but listing-owner export must not disclose reporter identity, report reasons, or moderation notes.',
	},
	{
		kind: 'user_columns',
		table: 'community_reports',
		columns: ['listing_owner_user_id', 'reporter_user_id'],
		includeInExport: false,
		surface: 'community_report_deletion_parties',
		reason:
			'This combined predicate exists for deletion. Export ownership is limited to the separate reporter predicate so listing owners cannot receive reports about their listings.',
	},
	{
		kind: 'user_columns',
		table: 'community_reports',
		columns: ['reporter_user_id'],
	},
	{
		kind: 'null_user_column',
		table: 'community_reports',
		matchColumn: 'resolved_by_user_id',
		nullColumns: ['resolved_by_user_id', 'resolved_at', 'resolution_note'],
		includeInExport: false,
	},
	{
		kind: 'user_columns',
		table: 'community_bans',
		columns: ['user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'community_bans',
		matchColumn: 'banned_by_user_id',
		setColumn: 'banned_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'community_listings',
		columns: ['owner_user_id'],
	},
	// Retired package slugs exist only to keep canonical package URLs resolving
	// after a package rename. They die with the account: once the packages are
	// gone there is nothing left to redirect to.
	{ kind: 'user_id', table: 'package_kody_id_redirects' },
	{ kind: 'user_id', table: 'package_slug_redirects' },
	// password_resets.user_id is an INTEGER FK to users.id (predates the
	// stable mcp string user id), so it must be handled with the database
	// integer id rather than the mcp user id.
	{ kind: 'db_user_id', table: 'email_verifications' },
	{ kind: 'db_user_id', table: 'pending_email_changes' },
	{ kind: 'db_user_id', table: 'email_notification_destinations' },
	{ kind: 'db_user_id', table: 'pending_email_destination_verifications' },
	{ kind: 'db_user_id', table: 'user_email_claims' },
	{ kind: 'db_user_id', table: 'pending_email_claim_releases' },
	{ kind: 'db_user_id', table: 'password_resets' },
	{ kind: 'db_user_id', table: 'user_roles' },
	{ kind: 'db_user_id', table: 'passkeys' },
	{ kind: 'db_user_id', table: 'user_mcp_oauth_clients' },
	{ kind: 'db_user_id', table: 'oauth_connections' },
	{ kind: 'user_id', table: 'handles' },
	{ kind: 'user_id', table: 'org_memberships' },
	{
		kind: 'replace_user_column',
		table: 'org_memberships',
		matchColumn: 'invited_by_user_id',
		setColumn: 'invited_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'user_id', table: 'org_user_budgets' },
	{
		kind: 'replace_user_column',
		table: 'org_user_budgets',
		matchColumn: 'set_by_user_id',
		setColumn: 'set_by_user_id',
		value: 'deleted-user',
	},
	// Overrides the deleted admin set stay on the org for audit; only the
	// admin id is anonymized.
	{
		kind: 'replace_user_column',
		table: 'org_limit_overrides',
		matchColumn: 'set_by_user_id',
		setColumn: 'set_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'orgs',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'replace_user_column',
		table: 'grants',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{
		kind: 'user_columns',
		table: 'invites',
		columns: ['invited_by_user_id', 'accepted_by_user_id'],
	},
	// Pending and consumed admin hard-delete approvals name both the target
	// person and the requesting admin. Either account's deletion removes them.
	{
		kind: 'user_columns',
		table: 'admin_account_deletion_approvals',
		columns: ['target_stable_user_id', 'requested_by_stable_user_id'],
	},
	{
		kind: 'replace_user_column',
		table: 'org_invite_links',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'user_id', table: 'org_invite_link_redemptions' },
	{ kind: 'user_id', table: 'org_invite_link_pending' },
	{
		kind: 'replace_user_column',
		table: 'teams',
		matchColumn: 'created_by_user_id',
		setColumn: 'created_by_user_id',
		value: 'deleted-user',
	},
	{ kind: 'user_id', table: 'team_members' },
	{
		kind: 'replace_user_column',
		table: 'team_members',
		matchColumn: 'added_by_user_id',
		setColumn: 'added_by_user_id',
		value: 'deleted-user',
	},
	// Feature-flag overrides use the integer users.id FK (with ON DELETE
	// CASCADE), but account deletion still issues an explicit DELETE so the
	// cascade stays self-contained when FK enforcement is disabled.
	{ kind: 'db_user_id', table: 'feature_flag_user_overrides' },
	// Two-factor verification rows are keyed by `target` = stringified db user
	// id rather than a user_id column, so they need the dedicated kind.
	{ kind: 'db_user_target', table: 'verifications' },
]

export function getAccountD1UserColumnCoverage() {
	const covered = new Set<string>()
	covered.add('users.stable_user_id')
	for (const target of accountUserDataTargets) {
		switch (target.kind) {
			case 'user_id':
			case 'db_user_id':
			case 'mcp_memory_suppression': {
				const table =
					target.kind === 'mcp_memory_suppression'
						? 'mcp_memory_conversation_suppressions'
						: target.table
				covered.add(`${table}.user_id`)
				break
			}
			case 'user_columns': {
				for (const column of target.columns) {
					// Inventory guards scan `user_id` / `*_user_id` only. Org
					// owner columns such as `follower_org_id` stay on the target
					// for purge but are not part of that coverage set.
					if (column === 'user_id' || column.endsWith('_user_id')) {
						covered.add(`${target.table}.${column}`)
					}
				}
				break
			}
			case 'null_user_column': {
				covered.add(`${target.table}.${target.matchColumn}`)
				break
			}
			case 'replace_user_column': {
				covered.add(`${target.table}.${target.matchColumn}`)
				break
			}
			case 'replace_user_id_in_json_column':
			case 'bucket_parent':
			case 'community_listing_child':
			// db_user_target tables key rows by `target`, not a *_user_id
			// column, so there is no schema column for the guard to cover.
			case 'db_user_target':
			case 'org_via_parent': {
				break
			}
			case 'org_id': {
				covered.add(`${target.table}.org_id`)
				break
			}
			default: {
				const exhaustive: never = target
				throw new Error(
					`Unhandled account data coverage target: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}
	return covered
}

/**
 * Shared match predicate for a user-scoped D1 target. Account deletion wraps
 * this in DELETE/UPDATE; account export uses the table-qualified form in
 * SELECT WHERE clauses. Keep both SQL shapes here so the two paths cannot
 * drift.
 */
export type UserScopedTargetMatch = {
	table: string
	/** Unqualified boolean SQL for DELETE/UPDATE WHERE clauses. */
	whereSql: string
	/** Table-qualified boolean SQL for SELECT WHERE clauses. */
	qualifiedWhereSql: string
	params: ReadonlyArray<unknown>
	mutation:
		| { kind: 'delete' }
		| { kind: 'null_columns'; columns: ReadonlyArray<string> }
		| { kind: 'replace_column'; column: string; value: string }
		| {
				kind: 'replace_json_string'
				column: string
				search: string
				replacement: string
		  }
		| {
				kind: 'replace_json_string_multi'
				column: string
				/** Nested REPLACE(...) expression already including column refs. */
				setExpr: string
		  }
}

export function resolveUserScopedTargetTable(
	target: UserScopedDataTarget,
): string {
	switch (target.kind) {
		case 'mcp_memory_suppression': {
			return 'mcp_memory_conversation_suppressions'
		}
		case 'user_id':
		case 'db_user_id':
		case 'db_user_target':
		case 'user_columns':
		case 'null_user_column':
		case 'replace_user_column':
		case 'replace_user_id_in_json_column':
		case 'bucket_parent':
		case 'community_listing_child':
		case 'org_id':
		case 'org_via_parent': {
			return target.table
		}
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled user-scoped target table: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

/**
 * Owner id (personal org / storage) plus optional person id when they differ.
 * Distinct personal orgs (#3053) store some rows under the person id and some
 * under the org id; matching both cleans both without moving legacy equal-id
 * rows.
 */
function storageAndPersonIds(input: {
	mcpUserId: string
	personUserId?: string
}): ReadonlyArray<string> {
	const person = input.personUserId?.trim() ?? ''
	if (person !== '' && person !== input.mcpUserId) {
		return [input.mcpUserId, person]
	}
	return [input.mcpUserId]
}

function columnInIdsSql(
	column: string,
	ids: ReadonlyArray<string>,
): { sql: string; params: ReadonlyArray<string> } {
	if (ids.length === 1) {
		return { sql: `${column} = ?`, params: ids }
	}
	return {
		sql: `${column} IN (${ids.map(() => '?').join(', ')})`,
		params: ids,
	}
}

export function buildUserScopedTargetMatch(input: {
	target: UserScopedDataTarget
	mcpUserId: string
	dbUserId: number
	/**
	 * Person id when it may differ from {@link mcpUserId} (storage / personal
	 * org). Omitted or equal keeps single-id matching for legacy equal-id
	 * accounts and team-org purge.
	 */
	personUserId?: string
}): UserScopedTargetMatch {
	const { target } = input
	const table = resolveUserScopedTargetTable(target)
	const ids = storageAndPersonIds(input)
	switch (target.kind) {
		case 'user_id': {
			const match = columnInIdsSql('user_id', ids)
			return {
				table,
				whereSql: match.sql,
				qualifiedWhereSql: columnInIdsSql(`${table}.user_id`, ids).sql,
				params: match.params,
				mutation: { kind: 'delete' },
			}
		}
		case 'db_user_id': {
			return {
				table,
				whereSql: 'user_id = ?',
				qualifiedWhereSql: `${table}.user_id = ?`,
				params: [input.dbUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'db_user_target': {
			return {
				table,
				whereSql: 'target = ?',
				qualifiedWhereSql: `${table}.target = ?`,
				params: [String(input.dbUserId)],
				mutation: { kind: 'delete' },
			}
		}
		case 'user_columns': {
			const clauses = target.columns.map((column) =>
				columnInIdsSql(column, ids),
			)
			const qualified = target.columns.map((column) =>
				columnInIdsSql(`${table}.${column}`, ids),
			)
			return {
				table,
				whereSql: clauses.map((clause) => clause.sql).join(' OR '),
				qualifiedWhereSql: qualified.map((clause) => clause.sql).join(' OR '),
				params: clauses.flatMap((clause) => clause.params),
				mutation: { kind: 'delete' },
			}
		}
		case 'null_user_column': {
			const match = columnInIdsSql(target.matchColumn, ids)
			return {
				table,
				whereSql: match.sql,
				qualifiedWhereSql: columnInIdsSql(`${table}.${target.matchColumn}`, ids)
					.sql,
				params: match.params,
				mutation: { kind: 'null_columns', columns: target.nullColumns },
			}
		}
		case 'replace_user_column': {
			const match = columnInIdsSql(target.matchColumn, ids)
			return {
				table,
				whereSql: match.sql,
				qualifiedWhereSql: columnInIdsSql(`${table}.${target.matchColumn}`, ids)
					.sql,
				params: match.params,
				mutation: {
					kind: 'replace_column',
					column: target.setColumn,
					value: target.value,
				},
			}
		}
		case 'replace_user_id_in_json_column': {
			const quotedIds = ids.map((id) => `"${id}"`)
			const quotedReplacement = `"${target.value}"`
			// D1 caps LIKE/GLOB patterns at 50 bytes ("LIKE or GLOB pattern too
			// complex"); a quoted 64-hex stable user id is 66. instr() has no
			// such limit and matches the same substring.
			if (quotedIds.length === 1) {
				const quotedUserId = quotedIds[0]!
				return {
					table,
					whereSql: `instr(${target.column}, ?) > 0`,
					qualifiedWhereSql: `instr(${table}.${target.column}, ?) > 0`,
					params: [quotedUserId],
					mutation: {
						kind: 'replace_json_string',
						column: target.column,
						search: quotedUserId,
						replacement: quotedReplacement,
					},
				}
			}
			const whereSql = quotedIds
				.map(() => `instr(${target.column}, ?) > 0`)
				.join(' OR ')
			const qualifiedWhereSql = quotedIds
				.map(() => `instr(${table}.${target.column}, ?) > 0`)
				.join(' OR ')
			// Nested REPLACE so both person and org id quotes become deleted-user.
			let setExpr = target.column
			for (const quoted of quotedIds) {
				setExpr = `REPLACE(${setExpr}, '${quoted.replace(/'/g, "''")}', '${quotedReplacement.replace(/'/g, "''")}')`
			}
			return {
				table,
				whereSql,
				qualifiedWhereSql,
				params: quotedIds,
				mutation: {
					kind: 'replace_json_string_multi',
					column: target.column,
					setExpr,
				},
			}
		}
		case 'bucket_parent': {
			const parentMatch = columnInIdsSql('user_id', ids)
			const whereSql = `bucket_id IN (
						SELECT id FROM ${target.parentTable} WHERE ${parentMatch.sql}
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `${table}.${whereSql}`,
				params: parentMatch.params,
				mutation: { kind: 'delete' },
			}
		}
		case 'community_listing_child': {
			const parentMatch = columnInIdsSql('owner_user_id', ids)
			const whereSql = `${target.listingColumn} IN (
						SELECT id FROM community_listings WHERE ${parentMatch.sql}
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `${table}.${whereSql}`,
				params: parentMatch.params,
				mutation: { kind: 'delete' },
			}
		}
		case 'mcp_memory_suppression': {
			const match = columnInIdsSql('user_id', ids)
			return {
				table,
				whereSql: match.sql,
				qualifiedWhereSql: columnInIdsSql(`${table}.user_id`, ids).sql,
				params: match.params,
				mutation: { kind: 'delete' },
			}
		}
		case 'org_id': {
			// Org-keyed columns use the storage owner id only.
			return {
				table,
				whereSql: 'org_id = ?',
				qualifiedWhereSql: `${table}.org_id = ?`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		case 'org_via_parent': {
			const whereSql = `${target.parentKey} IN (
						SELECT id FROM ${target.parentTable} WHERE org_id = ?
					)`
			return {
				table,
				whereSql,
				qualifiedWhereSql: `${table}.${whereSql}`,
				params: [input.mcpUserId],
				mutation: { kind: 'delete' },
			}
		}
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled user-scoped target match: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

export function buildUserScopedDeleteOrUpdateSql(
	match: UserScopedTargetMatch,
): { sql: string; params: ReadonlyArray<unknown> } {
	switch (match.mutation.kind) {
		case 'delete': {
			return {
				sql: `DELETE FROM ${match.table} WHERE ${match.whereSql}`,
				params: match.params,
			}
		}
		case 'null_columns': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.columns.map((column) => `${column} = NULL`).join(', ')}
						WHERE ${match.whereSql}`,
				params: match.params,
			}
		}
		case 'replace_column': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.column} = ?
						WHERE ${match.whereSql}`,
				params: [match.mutation.value, ...match.params],
			}
		}
		case 'replace_json_string': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.column} = REPLACE(${match.mutation.column}, ?, ?)
						WHERE ${match.whereSql}`,
				params: [
					match.mutation.search,
					match.mutation.replacement,
					...match.params,
				],
			}
		}
		case 'replace_json_string_multi': {
			return {
				sql: `UPDATE ${match.table}
						SET ${match.mutation.column} = ${match.mutation.setExpr}
						WHERE ${match.whereSql}`,
				params: match.params,
			}
		}
		default: {
			const exhaustive: never = match.mutation
			throw new Error(
				`Unhandled user-scoped mutation: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

// Secret values and credential-equivalent hashes must never leave Kody through
// account export. Secret entries are metadata-only; encrypted payloads stay
// server-side and token/password hashes are omitted for the same reason.
export const accountExportRedactedColumnsByTable: Readonly<
	Record<string, ReadonlyArray<string>>
> = {
	api_tokens: ['token_hash'],
	cli_credential_bootstrap_codes: ['code_hash'],
	email_verifications: ['token_hash'],
	org_invite_links: ['token_hash'],
	mcp_event_subscriptions: ['secret_encrypted', 'previous_secret_encrypted'],
	password_resets: ['token_hash'],
	pending_email_changes: ['token_hash'],
	pending_email_claim_releases: ['token_hash'],
	pending_email_destination_verifications: ['token_hash'],
	platform_feedback: ['reviewed_by_user_id', 'reviewed_at', 'admin_note'],
	secret_entries: ['encrypted_value', 'lookup_hash'],
	user_integrations: ['access_token_encrypted', 'refresh_token_encrypted'],
	user_oauth_apps: ['client_secret_encrypted'],
	users: ['password_hash'],
	verifications: ['secret'],
	webhook_endpoints: [
		'url_secret_hash',
		'url_secret_encrypted',
		'hmac_secret_encrypted',
		'hmac_verification_secret_encrypted',
		'previous_url_secret_hash',
		'previous_hmac_secret_encrypted',
	],
	webhook_apply_destination_pending: ['destination_json'],
	webhook_apply_destination_grants: ['destination_json'],
}

// Cross-user export rows can include another user's stable id. Keep the
// exporter's own id; replace every other value in these columns.
export const accountExportForeignUserIdColumnsByTable: Readonly<
	Record<string, ReadonlyArray<string>>
> = {
	community_activity_events: ['actor_user_id'],
	durable_object_duration_daily: ['actor_user_id'],
	usage_attribution_daily: ['actor_user_id'],
	usage_connection_daily: ['holder_user_id'],
	usage_rollups: ['actor_user_id'],
	community_reports: ['listing_owner_user_id', 'resolved_by_user_id'],
	account_write_lease_repairs: ['target_user_id', 'repaired_by_user_id'],
	package_codemod_runs: ['scope_user_id', 'initiated_by_user_id'],
	credential_inventory_runs: ['initiated_by_user_id'],
	grants: ['created_by_user_id'],
	invites: ['invited_by_user_id', 'accepted_by_user_id'],
	org_invite_links: ['created_by_user_id'],
	org_memberships: ['invited_by_user_id'],
	org_user_budgets: ['set_by_user_id'],
	org_limit_overrides: ['set_by_user_id'],
	orgs: ['created_by_user_id'],
	teams: ['created_by_user_id'],
	team_members: ['added_by_user_id'],
	mcp_server_settings: ['connected_by_user_id'],
	user_integrations: ['connected_by_user_id'],
	webhook_endpoints: ['created_by_user_id'],
	package_app_custom_hostnames: ['created_by_user_id'],
	referrals: ['referrer_stable_user_id', 'referee_stable_user_id'],
}

export const accountExportRedactedForeignUserId = '[redacted]'

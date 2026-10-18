/**
 * Every owner-keyed APP_DB table, classified for an operator org resource
 * transfer. `move` tables are re-pointed (or re-sealed, or rebuilt) by the
 * transfer; `keep` tables stay with the source owner, with the reason.
 * `org-transfer-tables.node.test.ts` fails when an account data target is
 * missing here, so a new owner-keyed table needs a deliberate decision.
 */

export type OrgTransferTableDisposition =
	| { disposition: 'move'; how: string }
	| { disposition: 'keep'; reason: string }

const move = (how: string) => ({ disposition: 'move', how }) as const
const keep = (reason: string) => ({ disposition: 'keep', reason }) as const

const personOwned =
	'Keyed by a person (login, credential, or person preference), not by the resource owner org.'
const usageHistory =
	'Usage, billing, and credit history stays with the org that incurred it.'
const orgMembershipShape =
	'Org structure and access configuration belong to the org itself.'
const emailStays =
	'Email inboxes, addresses, and sender identities stay; the target org gets its own inbox the normal way.'
const memoriesStay =
	'Memories are personal: they stay with their owning user and are never moved to another org.'

export const orgTransferTables: Record<string, OrgTransferTableDisposition> = {
	saved_packages: move(
		'user_id re-pointed; name rewritten to @<target slug>/<kody_id>.',
	),
	package_capability_approvals: keep(
		'Internet-visible capability approvals are owner attestations. Rows for moved packages are deleted so the destination owner must re-approve; is_internet_visible is cleared on transfer.',
	),
	package_security_audits: keep(
		'Informational package security audits. Rows for moved packages are deleted so the destination owner can re-audit.',
	),
	package_app_custom_hostnames: keep(
		'App-level rows bind by package_id (unchanged on transfer), so the hostname follows the moved package. Org-level rows bind by org_id and stay with the source org. created_by_user_id is attribution only.',
	),
	package_approval_requests: keep(
		'Approval requests are addressed to the source owner. Rows for moved packages are deleted; the destination owner gets a new request on the next publish.',
	),
	admin_account_deletion_approvals: keep(
		'Admin hard-delete approvals name a person and the requesting admin. They are not organization resources, so an org transfer leaves them in place.',
	),
	user_repos: move('user_id re-pointed.'),
	entity_sources: move(
		'user_id re-pointed for sources of moved packages and repos.',
	),
	published_bundle_artifacts: move(
		'user_id re-pointed for artifacts of moved sources (KV keys are per source).',
	),
	entity_source_artifacts_push_subscriptions: move(
		'user_id re-pointed for moved sources.',
	),
	community_listings: move(
		'owner_user_id re-pointed for listings of moved packages; name rewritten.',
	),
	community_forks: move(
		'forker_user_id re-pointed for forks that produced a moved package.',
	),
	follows: keep(
		'Follow rows stay with the follower org (follower_org_id is not re-pointed). The transfer batch rewrites denormalized target_owner_id and target_name so followers keep watching the same target ids under the destination owner.',
	),
	mcp_server_settings: move(
		'user_id re-pointed; the McpClientHub connection (tokens included) moves hub to hub.',
	),
	mcp_user_server_instructions: move('user_id re-pointed.'),
	user_oauth_apps: move(
		'user_id re-pointed; client secret re-sealed; logo copied under the target.',
	),
	user_integrations: move(
		'user_id re-pointed; access and refresh tokens re-sealed.',
	),
	secret_buckets: move(
		'User and package buckets re-pointed, or merged into the target bucket of the same scope and binding. Session buckets stay.',
	),
	secret_entries: move(
		'Values re-sealed under the target key context; bucket_id follows a merge.',
	),
	secret_provider_bindings: move(
		'user_id re-pointed for bindings of moved packages.',
	),
	secret_provider_grants: move('user_id re-pointed with their binding.'),
	user_storage_buckets: move(
		'Package and job buckets of moved packages re-pointed; StorageRunner data copied and verified.',
	),
	webhook_endpoints: move(
		'user_id re-pointed; URL and HMAC secrets re-sealed (URL hash unchanged).',
	),
	webhook_apply_destination_grants: move(
		'user_id re-pointed with their endpoint.',
	),
	webhook_apply_destination_pending: move(
		'user_id re-pointed with their endpoint.',
	),
	package_kody_id_redirects: move('user_id re-pointed for moved packages.'),
	package_slug_redirects: move('user_id re-pointed for moved packages.'),
	saved_package_search_index_debt: move(
		'Rows for moved packages deleted; the reindex under the target writes fresh debt.',
	),
	vector_embed_fingerprints: move(
		'Fingerprints for moved package and job vectors deleted; the reindex under the target writes new ones. Memory fingerprints stay with their owner.',
	),
	enablements: move('org_id re-pointed for triggers of moved packages.'),

	grants: keep(
		'Resource grants name source-org subjects; transfer refuses while any exist on moved resources.',
	),
	access_cache: keep('Compiled access; both orgs bump access_epoch.'),
	account_write_lease_repairs: keep(personOwned),
	agent_package_conversation_uses: keep(
		'Usage history keyed by the acting person, not the package owner org.',
	),
	api_tokens: keep(personOwned),
	approval_bundle_decisions: keep(
		'Decisions belong to bundles, which stay with the source org.',
	),
	approval_bundles: keep(
		'Bundles name source-org approvals; an agent bundles again in the target org.',
	),
	billing_promo_claims: keep(usageHistory),
	cli_credential_bootstrap_codes: keep(personOwned),
	community_activity_events: keep('Historical activity log.'),
	community_bans: keep(personOwned),
	community_ratings: keep(personOwned),
	community_reports: keep('Moderation history.'),
	connection_profiles: keep(personOwned),
	credential_inventory_items: keep(
		'Credential inventory results stay with the run that recorded them.',
	),
	credential_inventory_runs: keep(
		'Credential inventory results stay with the run that recorded them.',
	),
	credential_mappings: keep(
		'Mappings name source-org credentials and people; rows for moved packages stay behind unmatched and the target org maps its own.',
	),
	credential_mapping_proposals: keep(
		'Approved picks name source-org credentials; an agent proposes again in the target org.',
	),
	credential_org_grants: keep(personOwned),
	credit_debit_progress: keep(usageHistory),
	credit_ledger_entries: keep(usageHistory),
	credit_wallets: keep(usageHistory),
	durable_object_duration_daily: keep(usageHistory),
	email_inbound_due_owners: keep(emailStays),
	email_inbox_addresses: keep(emailStays),
	email_inboxes: keep(emailStays),
	email_notification_destinations: keep(emailStays),
	email_outbound_failure_tracking: keep(emailStays),
	email_outbound_provider_index: keep(emailStays),
	email_outbound_provider_index_repair_owners: keep(emailStays),
	email_sender_identities: keep(emailStays),
	email_sender_rules: keep(emailStays),
	email_verifications: keep(personOwned),
	feature_flag_exposure_rollups: keep(usageHistory),
	feature_flag_user_overrides: keep(personOwned),
	handles: keep(orgMembershipShape),
	invites: keep(orgMembershipShape),
	mcp_agent_sessions: keep('Live MCP sessions belong to the connecting owner.'),
	mcp_memories: keep(memoriesStay),
	mcp_memory_conversation_suppressions: keep(memoriesStay),
	mcp_event_subscriptions: keep(
		'Client callback subscriptions belong to the OAuth client connection.',
	),
	oauth_connections: keep(personOwned),
	org_invite_link_pending: keep(orgMembershipShape),
	org_invite_link_redemptions: keep(orgMembershipShape),
	org_invite_links: keep(orgMembershipShape),
	org_limit_overrides: keep(orgMembershipShape),
	org_memberships: keep(orgMembershipShape),
	org_user_budgets: keep(orgMembershipShape),
	orgs: keep(orgMembershipShape),
	package_codemod_run_items: keep(
		'Codemod run history (and revert snapshots) stays with the run.',
	),
	package_codemod_runs: keep(
		'Codemod run history (and revert snapshots) stays with the run.',
	),
	passkeys: keep(personOwned),
	password_resets: keep(personOwned),
	pending_email_changes: keep(personOwned),
	pending_email_claim_releases: keep(personOwned),
	pending_email_destination_verifications: keep(personOwned),
	platform_feedback: keep(personOwned),
	referrals: keep(personOwned),
	repo_session_due_owners: keep(
		'Repo session scheduling; sessions on moved sources are discarded after commit.',
	),
	team_members: keep(orgMembershipShape),
	teams: keep(orgMembershipShape),
	transactional_email_delivery_index: keep(emailStays),
	usage_attribution_daily: keep(usageHistory),
	usage_connection_daily: keep(usageHistory),
	usage_rollups: keep(usageHistory),
	user_email_claims: keep(personOwned),
	user_mcp_oauth_clients: keep(personOwned),
	user_roles: keep(personOwned),
	user_tips_email_opt_outs: keep(personOwned),
	user_usage_campaign_sends: keep(personOwned),
	user_usage_campaigns: keep(personOwned),
	verifications: keep(personOwned),
}

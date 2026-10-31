/**
 * APP_DB and JOBS_DB tables with `deleted_at` (Teams §10.3, migrations 0086/0087,
 * jobs 0002). Purge/offboarding modules extend this list only via migration.
 */

export const softDeleteAppTables = [
	'orgs',
	'users',
	'org_memberships',
	'teams',
	'team_members',
	'grants',
	'org_user_budgets',
	'saved_packages',
	'user_repos',
	'webhook_endpoints',
	'secret_buckets',
	'secret_entries',
	'secret_provider_bindings',
	'user_storage_buckets',
	'user_integrations',
	'user_oauth_apps',
	'mcp_server_settings',
	'mcp_memories',
	'mcp_user_server_instructions',
	'mcp_event_subscriptions',
	'email_inboxes',
	'email_inbox_addresses',
	'email_sender_rules',
	'email_sender_identities',
	'email_notification_destinations',
	'entity_sources',
	'community_listings',
	'api_tokens',
] as const

export type SoftDeleteAppTable = (typeof softDeleteAppTables)[number]

export const softDeleteJobsTables = ['jobs'] as const

export type SoftDeleteJobsTable = (typeof softDeleteJobsTables)[number]

export const softDeleteTables = [
	...softDeleteAppTables,
	...softDeleteJobsTables,
] as const

export type SoftDeleteTable = (typeof softDeleteTables)[number]

const softDeleteTableSet = new Set<string>(softDeleteTables)

export function isSoftDeleteTable(name: string): boolean {
	return softDeleteTableSet.has(name.trim().toLowerCase())
}

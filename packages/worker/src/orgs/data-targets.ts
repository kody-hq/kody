import {
	type UserScopedDataTarget,
	accountUserDataTargets,
} from '#worker/account/data-targets.ts'
import { softDeleteAppTables } from '#worker/soft-delete/tables.ts'

/**
 * APP_DB tables keyed by `user_id` where the owner id is an org stable id
 * (team org or personal org). Used for org soft-delete batch updates and org
 * hard purge D1 inventory.
 */
const orgOwnedUserIdSoftDeleteTableExclusions = new Set([
	'orgs',
	'users',
	'org_memberships',
	'teams',
	'team_members',
	'grants',
	'org_user_budgets',
	// Uses owner_user_id, not user_id.
	'community_listings',
	// Child rows keyed by bucket_id; soft-deleted via parent buckets.
	'secret_entries',
])

/** Child tables soft-deleted via their parent bucket after org soft-delete. */
export const orgOwnedBucketChildSoftDeleteTables = [
	{
		child: 'secret_entries',
		parent: 'secret_buckets',
		parentKey: 'bucket_id',
	},
] as const

export const orgOwnedUserIdSoftDeleteTables = softDeleteAppTables.filter(
	(table): table is (typeof softDeleteAppTables)[number] =>
		!orgOwnedUserIdSoftDeleteTableExclusions.has(table),
)

/**
 * Credential surfaces revoked on org soft-delete. Spec §10.3: credentials are
 * not restored even when the org is restored (the user reconnects).
 */
export const orgCredentialTablesExcludedFromRestore = [
	'api_tokens',
	'user_oauth_apps',
] as const

export const orgOwnedUserIdRestoreTables =
	orgOwnedUserIdSoftDeleteTables.filter(
		(table) =>
			!(
				orgCredentialTablesExcludedFromRestore as ReadonlyArray<string>
			).includes(table),
	)

/** Tables with an `org_id` column and `deleted_at` (Teams expand). */
export const orgScopedOrgIdSoftDeleteTables = [
	'org_memberships',
	'teams',
	'grants',
	'org_user_budgets',
] as const

export type HardPurgeSubject = 'person' | 'org'

/**
 * Org graph rows keyed by `org_id` (or a parent that is). Person deletion
 * anonymizes attribution on these tables instead of deleting the org.
 */
const orgStructuralHardPurgeTargets: ReadonlyArray<UserScopedDataTarget> = [
	{
		kind: 'org_via_parent',
		table: 'grant_permissions',
		parentTable: 'grants',
		parentKey: 'grant_id',
	},
	{ kind: 'org_id', table: 'grants' },
	{
		kind: 'org_via_parent',
		table: 'team_members',
		parentTable: 'teams',
		parentKey: 'team_id',
	},
	{ kind: 'org_id', table: 'teams' },
	{ kind: 'org_id', table: 'org_user_budgets' },
	{ kind: 'org_id', table: 'org_limit_overrides' },
	{ kind: 'org_id', table: 'enablements' },
	{ kind: 'org_id', table: 'credential_mappings' },
	{ kind: 'org_id', table: 'credential_mapping_proposals' },
	{
		kind: 'org_via_parent',
		table: 'approval_bundle_decisions',
		parentTable: 'approval_bundles',
		parentKey: 'bundle_id',
	},
	{ kind: 'org_id', table: 'approval_bundles' },
	{ kind: 'org_id', table: 'credential_org_grants' },
	{ kind: 'org_id', table: 'automation_execution_settings' },
	{ kind: 'org_id', table: 'execution_context_chain_entries' },
	{ kind: 'org_id', table: 'execution_context_chains' },
	{ kind: 'org_id', table: 'execution_context_opt_ins' },
	{ kind: 'org_id', table: 'execution_context_org_attachments' },
	{ kind: 'org_id', table: 'execution_context_registration_challenges' },
	{ kind: 'org_id', table: 'execution_contexts' },
	{ kind: 'org_id', table: 'profiles' },
	{ kind: 'org_id', table: 'org_memberships' },
	{ kind: 'org_id', table: 'invites' },
	{
		kind: 'org_via_parent',
		table: 'org_invite_link_redemptions',
		parentTable: 'org_invite_links',
		parentKey: 'link_id',
	},
	{
		kind: 'org_via_parent',
		table: 'org_invite_link_pending',
		parentTable: 'org_invite_links',
		parentKey: 'link_id',
	},
	{ kind: 'org_id', table: 'org_invite_links' },
	{ kind: 'org_id', table: 'access_cache' },
	{ kind: 'org_id', table: 'handles' },
	{ kind: 'org_id', table: 'org_audit_outbox' },
]

const orgOwnedUserIdSoftDeleteTableSet = new Set<string>(
	orgOwnedUserIdSoftDeleteTables,
)

/**
 * `user_id` tables that are person-scoped even when the row sits under a team
 * org (membership, redemption, attribution). Team org hard purge must not
 * delete these via `WHERE user_id = orgId`. Soft-delete org-owned tables are
 * allowlisted separately; these names stay excluded from the non-soft-delete
 * owner-inventory expansion (#3121).
 */
const personScopedUserIdTablesExcludedFromOrgHardPurge = new Set([
	'org_memberships',
	'team_members',
	'org_user_budgets',
	'org_invite_link_redemptions',
	'org_invite_link_pending',
])

/**
 * Org hard purge deletes org-owned rows from the person inventory (same match
 * builders and child-before-parent order) plus the org graph. Integer
 * person-account tables stay on the person subject. Owner-scoped account
 * inventory tables without `deleted_at` (for example `published_bundle_artifacts`)
 * are included so team org purge can remove them after out-of-band cleanup.
 */
function appliesToOrgHardPurge(target: UserScopedDataTarget): boolean {
	switch (target.kind) {
		case 'user_id':
			if (orgOwnedUserIdSoftDeleteTableSet.has(target.table)) return true
			if (personScopedUserIdTablesExcludedFromOrgHardPurge.has(target.table)) {
				return false
			}
			// Owner-scoped inventory without deleted_at (and other owner user_id
			// surfaces). Person-scoped rows keyed by a different id are a no-op
			// when bound to a team org id.
			return true
		case 'bucket_parent':
			return orgOwnedBucketChildSoftDeleteTables.some(
				(row) =>
					row.child === target.table && row.parent === target.parentTable,
			)
		case 'community_listing_child':
			return true
		case 'user_columns':
			// Owner id columns (community listings, package approvals, …)
			// plus org-owned follows (`follower_org_id`).
			return (
				target.columns.includes('owner_user_id') ||
				(target.table === 'follows' &&
					target.columns.includes('follower_org_id'))
			)
		case 'db_user_id':
		case 'db_user_target':
		case 'null_user_column':
		case 'replace_user_column':
		case 'replace_user_id_in_json_column':
		case 'mcp_memory_suppression':
		case 'org_id':
		case 'org_via_parent':
			return false
		default: {
			const exhaustive: never = target
			throw new Error(
				`Unhandled hard purge target: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

export type HardPurgeOrgMode = 'team' | 'personal'

/**
 * One hard-purge inventory. `person` is the account-deletion list.
 * `org` is the org-owned subset of that list plus org-graph deletes.
 * The scheduled purge lane still dry-runs while `SOFT_DELETE_PURGE_ENABLED`
 * is false; this function only names the rows.
 *
 * Prefer {@link hardPurgeOrgDataTargets} when choosing personal vs team org
 * behavior: personal mode leaves owner-scoped rows only when a soft-deleted
 * person will purge next.
 */
export function hardPurgeDataTargets(
	subject: HardPurgeSubject,
): ReadonlyArray<UserScopedDataTarget> {
	switch (subject) {
		case 'person':
			return accountUserDataTargets
		case 'org':
			return hardPurgeOrgDataTargets('team')
		default: {
			const exhaustive: never = subject
			throw new Error(`Unhandled hard purge subject: ${String(exhaustive)}`)
		}
	}
}

/**
 * D1 targets for org hard purge. `team` includes owner-scoped account inventory
 * (after out-of-band keys are collected). `personal` is org-graph only so a
 * subsequent soft-deleted-user purge can still inventory KV/R2/vectors from D1.
 */
export function hardPurgeOrgDataTargets(
	mode: HardPurgeOrgMode,
): ReadonlyArray<UserScopedDataTarget> {
	switch (mode) {
		case 'personal':
			return orgStructuralHardPurgeTargets
		case 'team':
			return [
				...accountUserDataTargets.filter(appliesToOrgHardPurge),
				...orgStructuralHardPurgeTargets,
			]
		default: {
			const exhaustive: never = mode
			throw new Error(`Unhandled hard purge org mode: ${String(exhaustive)}`)
		}
	}
}

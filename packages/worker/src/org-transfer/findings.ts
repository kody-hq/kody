export const orgTransferFindingCodes = [
	// Clashes: the target already holds something the move would create.
	'target_row_exists',
	'target_bucket_deleted_not_purged',
	'target_entry_exists',
	'target_mcp_instructions_exist',
	'target_hub_has_mcp_server',
	'target_storage_not_empty',
	// Blockers: the source is not in a movable state.
	'source_hub_missing_mcp_server',
	'integration_oauth_app_not_live',
	'enabler_not_target_member',
	'grant_names_source_subjects',
	'personal_credential_granted_to_org',
	// Refusals raised by apply itself.
	'orphans_present',
	'plan_drifted',
	// Warnings: the move proceeds but needs attention.
	'package_source_missing',
	'job_source_missing',
	'creator_grant_dropped',
	'profile_grant_dropped',
	// Post-commit warnings.
	'post_commit_step_failed',
] as const

export type OrgTransferFindingCode = (typeof orgTransferFindingCodes)[number]

/**
 * One machine-readable issue. `table` and `subject` name what it is about
 * (a table and a row label, or the post-commit step); never row values.
 */
export type OrgTransferFinding = {
	code: OrgTransferFindingCode
	message: string
	table?: string
	subject?: string
}

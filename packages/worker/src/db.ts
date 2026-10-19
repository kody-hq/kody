import { column as c, Database, sql, table } from 'remix/data-table'
import { createD1DatabaseDriver } from './d1-data-table-adapter.ts'

export const usersTable = table({
	name: 'users',
	columns: {
		id: c.integer(),
		username: c.text(),
		email: c.text(),
		stable_user_id: c.text(),
		personal_org_id: c.text(),
		display_name: c.text(),
		bio: c.text(),
		profile_visibility: c.text(),
		avatar_key: c.text(),
		password_hash: c.text(),
		email_verified_at: c.text(),
		deleting_at: c.text(),
		deleted_at: c.text(),
		suspended_at: c.text(),
		email_verification_delivery_status: c.text(),
		email_verification_delivery_at: c.text(),
		email_verification_delivery_detail: c.text(),
		email_verification_delivery_class: c.text(),
		password_changed_at: c.text(),
		utm_source: c.text(),
		utm_medium: c.text(),
		utm_campaign: c.text(),
		utm_content: c.text(),
		utm_term: c.text(),
		first_touch_landing_path: c.text(),
		first_touch_referrer: c.text(),
		first_mcp_connected_at: c.text(),
		first_execute_at: c.text(),
		first_search_at: c.text(),
		first_saved_package_at: c.text(),
		first_secret_at: c.text(),
		first_integration_at: c.text(),
		first_job_at: c.text(),
		mcp_client_name: c.text(),
		last_active_at: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export const passwordResetsTable = table({
	name: 'password_resets',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const emailVerificationsTable = table({
	name: 'email_verifications',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const pendingEmailChangesTable = table({
	name: 'pending_email_changes',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		new_email: c.text(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const userEmailClaimsTable = table({
	name: 'user_email_claims',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		email: c.text(),
		status: c.text(),
		claimed_at: c.text(),
		released_at: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export const emailNotificationDestinationsTable = table({
	name: 'email_notification_destinations',
	columns: {
		id: c.text(),
		user_id: c.integer(),
		email: c.text(),
		verified_at: c.text(),
		is_default: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const pendingEmailDestinationVerificationsTable = table({
	name: 'pending_email_destination_verifications',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		destination_id: c.text(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const pendingEmailClaimReleasesTable = table({
	name: 'pending_email_claim_releases',
	columns: {
		id: c.integer(),
		user_id: c.integer(),
		email: c.text(),
		token_hash: c.text(),
		expires_at: c.integer(),
		created_at: c.text(),
	},
	primaryKey: 'id',
})

export const oauthConnectionsTable = table({
	name: 'oauth_connections',
	columns: {
		id: c.integer(),
		provider_name: c.text(),
		provider_id: c.text(),
		user_id: c.integer(),
		provider_display_name: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export const orgsTable = table({
	name: 'orgs',
	columns: {
		id: c.text(),
		slug: c.text(),
		display_name: c.text(),
		bio: c.text(),
		avatar_key: c.text(),
		profile_visibility: c.text(),
		plan: c.text(),
		entitlement_ladder: c.text(),
		stripe_customer_id: c.text(),
		stripe_plan: c.text(),
		stripe_price_id: c.text(),
		stripe_plan_refreshed_at: c.text(),
		stripe_credits_eligible: c.integer(),
		admin_credits_eligible: c.integer(),
		second_agent_standard_gift_granted_at: c.text(),
		second_agent_standard_gift_expires_at: c.text(),
		referral_standard_credit_expires_at: c.text(),
		signup_welcome_credits_pending: c.integer(),
		default_user_budget_micro_usd: c.integer(),
		automation_budget_micro_usd: c.integer(),
		access_epoch: c.integer(),
		email_outbound_paused_at: c.text(),
		email_outbound_delivery_paused_at: c.text(),
		email_outbound_consecutive_failures: c.integer(),
		email_outbound_failure_watermark_at: c.text(),
		suspended_at: c.text(),
		deleted_at: c.text(),
		deleting_at: c.text(),
		created_by_user_id: c.text(),
		created_at: c.text(),
		updated_at: c.text(),
	},
	primaryKey: 'id',
})

export const orgMembershipsTable = table({
	name: 'org_memberships',
	columns: {
		org_id: c.text(),
		user_id: c.text(),
		role: c.text(),
		invited_by_user_id: c.text(),
		created_at: c.text(),
		deleted_at: c.text(),
	},
	primaryKey: ['org_id', 'user_id'],
})

export const handlesTable = table({
	name: 'handles',
	columns: {
		handle: c.text(),
		user_id: c.text(),
		org_id: c.text(),
		created_at: c.text(),
	},
	primaryKey: 'handle',
})

export function createDb(db: D1Database) {
	return new Database(createD1DatabaseDriver(db), {
		now: () => new Date().toISOString(),
	})
}

export type AppDatabase = ReturnType<typeof createDb>
export { sql }

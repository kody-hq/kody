/**
 * Minimal Teams expand tables for worker tests that start from an empty D1.
 */
export async function ensureOrgsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS orgs (
				id TEXT PRIMARY KEY NOT NULL,
				slug TEXT NOT NULL UNIQUE,
				display_name TEXT,
				bio TEXT,
				avatar_key TEXT,
				profile_visibility TEXT NOT NULL DEFAULT 'public',
				plan TEXT NOT NULL DEFAULT 'free',
				entitlement_ladder TEXT NOT NULL DEFAULT 'public',
				stripe_customer_id TEXT,
				stripe_plan TEXT,
				stripe_price_id TEXT,
				stripe_plan_refreshed_at TEXT,
				stripe_credits_eligible INTEGER NOT NULL DEFAULT 0,
				admin_credits_eligible INTEGER NOT NULL DEFAULT 0,
				second_agent_standard_gift_granted_at TEXT,
				second_agent_standard_gift_expires_at TEXT,
				referral_standard_credit_expires_at TEXT,
				signup_welcome_credits_pending INTEGER NOT NULL DEFAULT 0,
				email_outbound_paused_at TEXT,
				email_outbound_delivery_paused_at TEXT,
				email_outbound_consecutive_failures INTEGER NOT NULL DEFAULT 0,
				email_outbound_failure_watermark_at TEXT,
				default_user_budget_micro_usd INTEGER,
				automation_budget_micro_usd INTEGER,
				suspended_at TEXT,
				deleted_at TEXT,
				deleting_at TEXT,
				access_epoch INTEGER NOT NULL DEFAULT 0,
				created_by_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	try {
		await db
			.prepare(
				`ALTER TABLE orgs ADD COLUMN access_epoch INTEGER NOT NULL DEFAULT 0`,
			)
			.run()
	} catch {
		// Column already present on fuller schemas / re-runs.
	}
	try {
		await db
			.prepare(
				`ALTER TABLE orgs ADD COLUMN email_outbound_delivery_paused_at TEXT`,
			)
			.run()
	} catch {
		// Column already present on fuller schemas / re-runs.
	}
	try {
		await db
			.prepare(
				`ALTER TABLE orgs ADD COLUMN email_outbound_consecutive_failures INTEGER NOT NULL DEFAULT 0`,
			)
			.run()
	} catch {
		// Column already present on fuller schemas / re-runs.
	}
	try {
		await db
			.prepare(
				`ALTER TABLE orgs ADD COLUMN email_outbound_failure_watermark_at TEXT`,
			)
			.run()
	} catch {
		// Column already present on fuller schemas / re-runs.
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_memberships (
				org_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				role TEXT NOT NULL,
				invited_by_user_id TEXT,
				created_at TEXT NOT NULL,
				deleted_at TEXT,
				PRIMARY KEY (org_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS handles (
				handle TEXT PRIMARY KEY NOT NULL,
				user_id TEXT,
				org_id TEXT,
				created_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS teams (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				slug TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT,
				parent_team_id TEXT,
				created_by_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT,
				UNIQUE (org_id, slug)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS team_members (
				team_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				added_by_user_id TEXT,
				created_at TEXT NOT NULL,
				deleted_at TEXT,
				PRIMARY KEY (team_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS grants (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				resource_type TEXT NOT NULL,
				resource_id TEXT NOT NULL,
				subject_type TEXT NOT NULL,
				subject_id TEXT NOT NULL,
				preset TEXT,
				created_by_user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS grant_permissions (
				grant_id TEXT NOT NULL,
				permission TEXT NOT NULL,
				PRIMARY KEY (grant_id, permission)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS invites (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				role TEXT,
				team_ids_json TEXT,
				resource_type TEXT,
				resource_id TEXT,
				permissions_json TEXT,
				preset TEXT,
				invitee_email TEXT,
				invitee_username TEXT,
				token_hash TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL,
				invited_by_user_id TEXT NOT NULL,
				accepted_by_user_id TEXT,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				accepted_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS enablements (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				package_id TEXT,
				trigger_kind TEXT NOT NULL,
				trigger_name TEXT NOT NULL,
				instance_id TEXT NOT NULL,
				enabler_user_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'on',
				paused_reason TEXT,
				paused_permission TEXT,
				paused_resource_type TEXT,
				paused_resource_id TEXT,
				paused_credential_id TEXT,
				paused_at TEXT,
				credential_mapping_json TEXT,
				origin TEXT NOT NULL,
				sender_kind TEXT,
				sender_value TEXT,
				enabled_at TEXT NOT NULL,
				disabled_at TEXT,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	for (const statement of [
		`ALTER TABLE enablements ADD COLUMN sender_kind TEXT`,
		`ALTER TABLE enablements ADD COLUMN sender_value TEXT`,
	]) {
		try {
			await db.prepare(statement).run()
		} catch {
			// Column already present on fuller schemas / re-runs.
		}
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credential_mappings (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				need_key TEXT NOT NULL,
				target TEXT NOT NULL,
				person_user_id TEXT NOT NULL DEFAULT '',
				enablement_id TEXT NOT NULL DEFAULT '',
				credential_ids_json TEXT NOT NULL DEFAULT '[]',
				updated_by_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credential_mapping_proposals (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				person_user_id TEXT NOT NULL,
				agent_credential_kind TEXT NOT NULL,
				agent_credential_id TEXT NOT NULL,
				proposal_json TEXT NOT NULL,
				approved_picks_json TEXT,
				approved_at TEXT,
				created_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS approval_bundles (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				person_user_id TEXT NOT NULL,
				agent_credential_kind TEXT,
				agent_credential_id TEXT,
				note TEXT,
				items_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS approval_bundle_decisions (
				bundle_id TEXT NOT NULL,
				item_key TEXT NOT NULL,
				decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
				decided_by_user_id TEXT NOT NULL,
				decided_at TEXT NOT NULL,
				finalized_at TEXT,
				PRIMARY KEY (bundle_id, item_key)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_invite_links (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				token_hash TEXT NOT NULL UNIQUE,
				kind TEXT NOT NULL DEFAULT 'membership',
				role TEXT,
				team_id TEXT,
				resource_type TEXT,
				resource_id TEXT,
				preset TEXT,
				allowed_email_domains_json TEXT,
				max_uses INTEGER,
				use_count INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL,
				created_by_user_id TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				revoked_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_invite_link_redemptions (
				link_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (link_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_invite_link_pending (
				link_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (link_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS access_cache (
				org_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				compiled_json TEXT NOT NULL,
				computed_at TEXT NOT NULL,
				PRIMARY KEY (org_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_user_budgets (
				org_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				monthly_budget_micro_usd INTEGER NOT NULL,
				set_by_user_id TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT,
				PRIMARY KEY (org_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS billing_promo_claims (
				user_id TEXT PRIMARY KEY NOT NULL,
				promotion_code_id TEXT NOT NULL,
				org_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed')),
				checkout_session_id TEXT,
				reserved_at TEXT NOT NULL,
				claimed_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_audit_outbox (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_org_audit_outbox_created_at
			 ON org_audit_outbox (created_at)`,
		)
		.run()
}

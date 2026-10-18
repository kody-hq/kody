import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'

export async function ensureEmailTestSchema(db: D1Database) {
	// Outbound sends increment the entitlement daily counter, so any suite
	// exercising email sends needs the entitlement tables too.
	await ensureEntitlementTestSchema(db)
	const statements = [
		`DROP TABLE IF EXISTS pending_email_destination_verifications;`,
		`DROP TABLE IF EXISTS email_notification_destinations;`,
		`DROP TABLE IF EXISTS transactional_email_delivery_index;`,
		`DROP TABLE IF EXISTS email_delivery_alert_events;`,
		`DROP TABLE IF EXISTS email_outbound_provider_index_repair_owners;`,
		`DROP TABLE IF EXISTS email_inbound_due_owners;`,
		`DROP TABLE IF EXISTS email_user_graph_authority;`,
		`DROP TABLE IF EXISTS system_email_graph_authority;`,
		`DROP TABLE IF EXISTS system_email_daily_counters;`,
		`DROP TABLE IF EXISTS system_email_delivery_events;`,
		`DROP TABLE IF EXISTS system_email_attachments;`,
		`DROP TABLE IF EXISTS system_email_messages;`,
		`DROP TABLE IF EXISTS system_email_threads;`,
		`DROP TABLE IF EXISTS email_sender_policies;`,
		`DROP TABLE IF EXISTS email_sender_rules;`,
		`DROP TABLE IF EXISTS email_delivery_events;`,
		`DROP TABLE IF EXISTS email_attachments;`,
		`DROP TABLE IF EXISTS email_outbound_failure_tracking;`,
		`DROP TABLE IF EXISTS email_outbound_provider_index;`,
		`DROP TABLE IF EXISTS email_messages;`,
		`DROP TABLE IF EXISTS email_threads;`,
		`DROP TABLE IF EXISTS email_inbox_addresses;`,
		`DROP TABLE IF EXISTS email_inboxes;`,
		`DROP TABLE IF EXISTS email_sender_identities;`,
		`CREATE TABLE IF NOT EXISTS email_sender_identities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	email TEXT NOT NULL,
	domain TEXT,
	display_name TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK (status IN ('verified')),
	verified_at TEXT,
	deleted_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_identities_user_email
ON email_sender_identities(user_id, email);`,

		`CREATE TABLE IF NOT EXISTS email_inboxes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	deleted_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,

		`CREATE TABLE IF NOT EXISTS email_inbox_addresses (
	id TEXT PRIMARY KEY,
	inbox_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	address TEXT NOT NULL UNIQUE,
	local_part TEXT NOT NULL,
	domain TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	deleted_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE CASCADE
);`,

		`CREATE TABLE IF NOT EXISTS email_sender_rules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
	value TEXT NOT NULL,
	effect TEXT NOT NULL CHECK (effect IN ('allow', 'block', 'quarantine')),
	note TEXT NOT NULL DEFAULT '',
	deleted_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_rules_user_kind_value
ON email_sender_rules(user_id, kind, value);`,

		`CREATE TABLE IF NOT EXISTS system_email_threads (
	id TEXT PRIMARY KEY,
	inbox_id TEXT,
	subject_normalized TEXT NOT NULL DEFAULT '',
	root_message_id_header TEXT,
	last_message_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);`,
		`CREATE TABLE IF NOT EXISTS system_email_messages (
	id TEXT PRIMARY KEY,
	direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
	inbox_id TEXT,
	thread_id TEXT,
	sender_identity_id TEXT,
	from_address TEXT NOT NULL,
	envelope_from TEXT,
	to_addresses_json TEXT NOT NULL DEFAULT '[]',
	cc_addresses_json TEXT NOT NULL DEFAULT '[]',
	bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
	reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
	subject TEXT NOT NULL DEFAULT '',
	message_id_header TEXT,
	in_reply_to_header TEXT,
	references_json TEXT NOT NULL DEFAULT '[]',
	headers_json TEXT NOT NULL DEFAULT '{}',
	auth_results TEXT,
	text_body TEXT,
	html_body TEXT,
	raw_size INTEGER NOT NULL DEFAULT 0,
	processing_status TEXT NOT NULL CHECK (
		processing_status IN ('stored', 'sent', 'failed')
	),
	provider_message_id TEXT,
	error TEXT,
	received_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	raw_mime_key TEXT,
	delivery_status TEXT CHECK (
		delivery_status IS NULL OR delivery_status IN (
			'delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'
		)
	),
	delivery_status_at TEXT,
	classification TEXT NOT NULL DEFAULT 'accepted' CHECK (
		classification IN ('accepted', 'quarantined')
	),
	classification_reason TEXT,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL,
	FOREIGN KEY (thread_id) REFERENCES system_email_threads(id) ON DELETE SET NULL,
	FOREIGN KEY (sender_identity_id) REFERENCES email_sender_identities(id)
		ON DELETE SET NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_system_email_messages_provider_message_id
ON system_email_messages(provider_message_id)
WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;`,
		`CREATE TABLE IF NOT EXISTS system_email_attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	filename TEXT,
	content_type TEXT NOT NULL,
	content_id TEXT,
	disposition TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	storage_kind TEXT NOT NULL CHECK (
		storage_kind IN ('raw-mime', 'external', 'unavailable')
	),
	storage_key TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES system_email_messages(id)
		ON DELETE CASCADE
);`,
		`CREATE TABLE IF NOT EXISTS system_email_delivery_events (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (
		event_type IN (
			'receive_started', 'received', 'rejected', 'send_requested', 'sent',
			'failed', 'delivered', 'deferred', 'bounced', 'complained'
		)
	),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	provider_event_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	needs_effect_reconcile INTEGER NOT NULL DEFAULT 1 CHECK (
		needs_effect_reconcile IN (0, 1)
	),
	usage_effect_recorded_at TEXT,
	usage_month TEXT,
	usage_bytes INTEGER,
	usage_duration_ms INTEGER,
	state TEXT CHECK (
		state IS NULL OR state IN (
			'pending', 'storing', 'cleaning', 'received', 'rejected', 'orphan-cleaned'
		)
	),
	fingerprint TEXT,
	storage_lease TEXT,
	storage_lease_at TEXT,
	cleanup_lease TEXT,
	cleanup_lease_at TEXT,
	cleanup_retry_at TEXT,
	expected_attachment_count INTEGER,
	finalization_token TEXT,
	reconcile_after TEXT,
	dedupe_expires_at TEXT,
	usage_effect_suppressed_at TEXT,
	usage_started_at TEXT,
	usage_effect_retry_at TEXT,
	usage_effect_lease TEXT,
	usage_effect_lease_at TEXT,
	subscription_effect_state TEXT CHECK (
		subscription_effect_state IS NULL OR subscription_effect_state IN (
			'pending', 'processing', 'complete', 'dead-letter'
		)
	),
	subscription_effect_lease TEXT,
	subscription_effect_lease_at TEXT,
	subscription_effect_retry_at TEXT,
	subscription_effect_attempt_count INTEGER,
	subscription_effect_dead_letter_at TEXT,
	subscription_effect_last_error TEXT,
	updated_at TEXT,
	FOREIGN KEY (message_id) REFERENCES system_email_messages(id)
		ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_system_email_delivery_events_provider_event_id
ON system_email_delivery_events(provider_event_id)
WHERE provider_event_id IS NOT NULL;`,
		`CREATE TABLE IF NOT EXISTS email_notification_destinations (
	id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	email TEXT NOT NULL,
	verified_at TEXT,
	is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
	deleted_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_notification_destinations_user_email
ON email_notification_destinations(user_id, email);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_notification_destinations_user_default
ON email_notification_destinations(user_id)
WHERE is_default = 1;`,
		`CREATE TABLE IF NOT EXISTS pending_email_destination_verifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	destination_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);`,
		`CREATE TABLE IF NOT EXISTS transactional_email_delivery_index (
	provider_message_id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	kind TEXT NOT NULL,
	recipient TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	last_status TEXT,
	last_status_at TEXT
);`,
		`CREATE INDEX IF NOT EXISTS idx_transactional_email_delivery_user_id
ON transactional_email_delivery_index(user_id);`,
		`CREATE TABLE IF NOT EXISTS email_outbound_failure_tracking (
	provider_event_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	delivery_status TEXT NOT NULL,
	created_at TEXT NOT NULL,
	applied_at TEXT
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_outbound_failure_tracking_user_id
ON email_outbound_failure_tracking(user_id);`,
		`CREATE TABLE IF NOT EXISTS email_outbound_provider_index (
	provider TEXT NOT NULL,
	provider_message_id TEXT NOT NULL,
	user_id TEXT NOT NULL CHECK (user_id <> 'system:email'),
	message_id TEXT NOT NULL,
	inbox_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_message_id)
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_outbound_provider_index_user_id
ON email_outbound_provider_index(user_id);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbound_provider_index_message_id
ON email_outbound_provider_index(message_id);`,
		`CREATE TABLE IF NOT EXISTS email_user_graph_authority (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
	frozen_at TEXT NOT NULL,
	dropped_at TEXT NOT NULL
);`,
		`INSERT INTO email_user_graph_authority (
	singleton, owner_count, frozen_at, dropped_at
) VALUES (
	1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);`,
		`CREATE TABLE IF NOT EXISTS email_inbound_due_owners (
	user_id TEXT PRIMARY KEY NOT NULL CHECK (user_id != 'system:email'),
	due_at TEXT NOT NULL,
	reason TEXT NOT NULL,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	updated_at TEXT NOT NULL
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_inbound_due_owners_priority_due_at
ON email_inbound_due_owners(
	due_at,
	user_id
);`,
		`CREATE TABLE IF NOT EXISTS email_outbound_provider_index_repair_owners (
	user_id TEXT PRIMARY KEY NOT NULL,
	pending_count INTEGER NOT NULL,
	oldest_pending_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS email_delivery_alert_events (
	provider_event_id TEXT PRIMARY KEY NOT NULL,
	provider TEXT NOT NULL,
	event_type TEXT NOT NULL,
	occurred_at TEXT NOT NULL,
	owner_hash TEXT,
	created_at TEXT NOT NULL
);`,
		`CREATE TABLE IF NOT EXISTS system_email_daily_counters (
	local_part TEXT NOT NULL,
	day TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	operation_token TEXT,
	PRIMARY KEY (local_part, day)
);`,
		`CREATE TABLE IF NOT EXISTS system_email_graph_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	authority TEXT NOT NULL CHECK (authority = 'dedicated'),
	cutover_at TEXT NOT NULL,
	graph_mismatch_count INTEGER NOT NULL CHECK (graph_mismatch_count = 0),
	provider_link_count INTEGER NOT NULL CHECK (provider_link_count = 0),
	deleted_at TEXT
);`,
		`INSERT INTO system_email_graph_authority (
	singleton, authority, cutover_at, graph_mismatch_count, provider_link_count
) VALUES (1, 'dedicated', CURRENT_TIMESTAMP, 0, 0);`,
		`DROP TABLE IF EXISTS email_recipient_cooldowns;`,
		`DROP TABLE IF EXISTS email_rejecting_providers;`,
		`DROP TABLE IF EXISTS email_mx_lookup_cache;`,
		`CREATE TABLE IF NOT EXISTS email_recipient_cooldowns (
	recipient TEXT PRIMARY KEY NOT NULL,
	class TEXT NOT NULL,
	reason TEXT,
	cooldown_until TEXT NOT NULL,
	last_failure_at TEXT NOT NULL,
	failure_count INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_recipient_cooldowns_until
ON email_recipient_cooldowns(cooldown_until);`,
		`CREATE TABLE IF NOT EXISTS email_rejecting_providers (
	provider_key TEXT PRIMARY KEY NOT NULL,
	last_rejection_at TEXT NOT NULL,
	rejection_count INTEGER NOT NULL DEFAULT 1,
	last_recipient_domain TEXT,
	seeded INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_rejecting_providers_last_rejection
ON email_rejecting_providers(last_rejection_at);`,
		`CREATE TABLE IF NOT EXISTS email_mx_lookup_cache (
	domain TEXT PRIMARY KEY NOT NULL,
	provider_keys_json TEXT NOT NULL,
	mx_hosts_json TEXT NOT NULL,
	looked_up_at TEXT NOT NULL,
	expires_at TEXT NOT NULL
);`,
		`CREATE INDEX IF NOT EXISTS idx_email_mx_lookup_cache_expires
ON email_mx_lookup_cache(expires_at);`,
		`CREATE TABLE IF NOT EXISTS email_verification_hard_bounces (
	recipient TEXT PRIMARY KEY NOT NULL,
	status TEXT NOT NULL,
	detail TEXT,
	suppressed_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
	await ensureSoftDeleteTestColumns(db)
}

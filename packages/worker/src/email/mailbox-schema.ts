import {
	mailboxMetaSchemaVersionKey,
	mailboxSchemaVersion,
} from './mailbox-types.ts'

export function getMailboxMeta(
	storage: DurableObjectStorage,
	key: string,
): number | null {
	const row = storage.sql
		.exec<{ value: number }>(
			`SELECT value FROM mailbox_meta WHERE key = ? LIMIT 1`,
			key,
		)
		.toArray()[0]
	return row == null ? null : Number(row.value) || 0
}

export function setMailboxMeta(
	storage: DurableObjectStorage,
	key: string,
	value: number,
) {
	storage.sql.exec(
		`INSERT INTO mailbox_meta (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key,
		value,
	)
}

/**
 * Schema bootstrap + warm migrations.
 * - v1: base tables/indexes (deployed).
 * - v2: additive inbound ledger query indexes (state/reconcile/retry/dedupe).
 * - v3: permanent message deletion tombstones fence delayed-writer resurrection.
 * - v4: durable per-message retention retry eligibility and diagnostics.
 * - v5: durable outbound provider-index repair ledger.
 * - v6: `email_messages` gains `archived_at` and a `spam` classification.
 *   SQLite cannot widen a CHECK in place, so warm objects rebuild the table
 *   once (rows copied verbatim, `archived_at` NULL).
 * Warm objects re-run CREATE IF NOT EXISTS then apply any version-gated
 * additions; never destructive.
 */
export function initializeMailboxSchema(storage: DurableObjectStorage) {
	const sql = storage.sql
	sql.exec(`
		CREATE TABLE IF NOT EXISTS mailbox_meta (
			key TEXT PRIMARY KEY NOT NULL,
			value INTEGER NOT NULL
		)
	`)
	const installedVersion = getMailboxMeta(storage, mailboxMetaSchemaVersionKey)
	if (installedVersion === mailboxSchemaVersion) return

	/**
	 * Cloudflare DO runtime does not expose a reverse lookup from the object
	 * id to the `idFromName` string, so the human owner id is not
	 * introspectable inside the DO. Ownership for blob-key validation and
	 * cross-user rejection is an explicit write-contract field, persisted
	 * once in this singleton row. Data rows still have no `user_id` column.
	 */
	sql.exec(`
		CREATE TABLE IF NOT EXISTS mailbox_owner_identity (
			singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
			owner_id TEXT NOT NULL
		)
	`)
	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_message_deletion_tombstones (
			message_id TEXT PRIMARY KEY NOT NULL,
			deleted_at TEXT NOT NULL
		)
	`)

	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_threads (
			id TEXT PRIMARY KEY NOT NULL,
			inbox_id TEXT,
			subject_normalized TEXT NOT NULL DEFAULT '',
			root_message_id_header TEXT,
			last_message_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_threads_last_message_at
		ON email_threads(last_message_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_threads_root_message_id
		ON email_threads(root_message_id_header)
		WHERE root_message_id_header IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_threads_created_at
		ON email_threads(created_at ASC, id ASC)`,
	)

	sql.exec(emailMessagesTableSql('email_messages', { ifNotExists: true }))
	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_outbound_provider_index_repairs (
			provider TEXT NOT NULL,
			provider_message_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			inbox_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			retry_at TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
			last_error TEXT,
			PRIMARY KEY (provider, provider_message_id)
		)
	`)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_outbound_provider_index_repairs_retry
		ON email_outbound_provider_index_repairs(retry_at, provider, provider_message_id)`,
	)
	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_message_retention_retries (
			message_id TEXT PRIMARY KEY NOT NULL,
			retry_at TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 1,
			last_error TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
		)
	`)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_message_retention_retries_retry_at
		ON email_message_retention_retries(retry_at ASC, message_id ASC)`,
	)
	// After every table that references email_messages exists.
	if (!emailMessagesHasArchivedAt(sql)) {
		rebuildEmailMessagesForSpamAndArchive(storage)
	}
	createEmailMessageIndexes(sql)

	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_attachments (
			id TEXT PRIMARY KEY NOT NULL,
			message_id TEXT NOT NULL,
			filename TEXT,
			content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
			content_id TEXT,
			disposition TEXT,
			size INTEGER NOT NULL DEFAULT 0,
			storage_kind TEXT NOT NULL CHECK (
				storage_kind IN ('raw-mime', 'external', 'unavailable')
			),
			storage_key TEXT,
			created_at TEXT NOT NULL
		)
	`)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_attachments_message_id
		ON email_attachments(message_id)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_attachments_storage_key
		ON email_attachments(id ASC)
		WHERE storage_key IS NOT NULL`,
	)

	sql.exec(`
		CREATE TABLE IF NOT EXISTS email_delivery_events (
			id TEXT PRIMARY KEY NOT NULL,
			message_id TEXT,
			inbox_id TEXT,
			event_type TEXT NOT NULL CHECK (
				event_type IN (
					'receive_started', 'received', 'rejected', 'send_requested',
					'sent', 'failed', 'delivered', 'deferred', 'bounced', 'complained'
				)
			),
			provider TEXT NOT NULL DEFAULT 'kody',
			provider_message_id TEXT,
			provider_event_id TEXT,
			detail_json TEXT NOT NULL DEFAULT '{}',
			needs_effect_reconcile INTEGER NOT NULL DEFAULT 0 CHECK (
				needs_effect_reconcile IN (0, 1)
			),
			state TEXT CHECK (
				state IS NULL OR state IN (
					'pending', 'storing', 'cleaning', 'received',
					'rejected', 'orphan-cleaned'
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
			usage_effect_recorded_at TEXT,
			usage_effect_suppressed_at TEXT,
			usage_started_at TEXT,
			usage_month TEXT,
			usage_bytes INTEGER,
			usage_duration_ms INTEGER,
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
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
		ON email_delivery_events(message_id)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at
		ON email_delivery_events(created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_created_at_asc
		ON email_delivery_events(created_at ASC, id ASC)`,
	)
	sql.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_delivery_events_provider_event_id
		ON email_delivery_events(provider_event_id)
		WHERE provider_event_id IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_pending_effects
		ON email_delivery_events(created_at ASC, id ASC)
		WHERE needs_effect_reconcile = 1
			AND fingerprint IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_state_created
		ON email_delivery_events(state, created_at ASC)
		WHERE state IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_fingerprint
		ON email_delivery_events(fingerprint)
		WHERE fingerprint IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_dedupe_expires
		ON email_delivery_events(dedupe_expires_at ASC)
		WHERE dedupe_expires_at IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recorded_usage_month
		ON email_delivery_events(usage_month, created_at ASC)
		WHERE usage_effect_recorded_at IS NOT NULL`,
	)

	// v2 — inbound ledger CAS due-work indexes (safe on warm v1 objects).
	if (installedVersion == null || installedVersion < 2) {
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_reconcile_after
			ON email_delivery_events(reconcile_after ASC, created_at ASC, id ASC)
			WHERE reconcile_after IS NOT NULL`,
		)
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_usage_effect_retry
			ON email_delivery_events(usage_effect_retry_at ASC, id ASC)
			WHERE needs_effect_reconcile = 1
				AND usage_effect_recorded_at IS NULL
				AND usage_effect_suppressed_at IS NULL`,
		)
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_subscription_effect_retry
			ON email_delivery_events(subscription_effect_retry_at ASC, id ASC)
			WHERE needs_effect_reconcile = 1
				AND (
					subscription_effect_state IS NULL
					OR subscription_effect_state NOT IN ('complete', 'dead-letter')
				)`,
		)
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_stale_state
			ON email_delivery_events(state, created_at ASC, id ASC)
			WHERE state IN ('pending', 'storing', 'cleaning', 'orphan-cleaned')`,
		)
		// Literal matches mailboxInboundDedupeProvider; keep local to avoid a
		// mailbox-types ↔ ledger ↔ schema import cycle.
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_email_delivery_events_dedupe_provider_expires
			ON email_delivery_events(provider, dedupe_expires_at ASC, id ASC)
			WHERE provider = 'cloudflare-email-routing-dedupe'
				AND dedupe_expires_at IS NOT NULL`,
		)
	}

	setMailboxMeta(storage, mailboxMetaSchemaVersionKey, mailboxSchemaVersion)
}

function emailMessagesTableSql(
	name: string,
	options: { ifNotExists: boolean },
): string {
	return `
		CREATE TABLE ${options.ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
			id TEXT PRIMARY KEY NOT NULL,
			direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
			inbox_id TEXT,
			thread_id TEXT,
			sender_identity_id TEXT,
			from_address TEXT NOT NULL DEFAULT '',
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
			raw_mime_key TEXT,
			raw_size INTEGER NOT NULL DEFAULT 0,
			processing_status TEXT NOT NULL CHECK (
				processing_status IN ('stored', 'sent', 'failed')
			),
			classification TEXT NOT NULL DEFAULT 'accepted' CHECK (
				classification IN ('accepted', 'quarantined', 'spam')
			),
			classification_reason TEXT,
			provider_message_id TEXT,
			delivery_status TEXT CHECK (
				delivery_status IS NULL OR delivery_status IN (
					'delivered', 'deferred', 'bounced', 'failed',
					'rejected', 'complained'
				)
			),
			delivery_status_at TEXT,
			error TEXT,
			received_at TEXT,
			sent_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			archived_at TEXT
		)
	`
}

/** Pre-v6 columns, in table order; the v6 rebuild copies exactly these. */
const preV6EmailMessageColumns = [
	'id',
	'direction',
	'inbox_id',
	'thread_id',
	'sender_identity_id',
	'from_address',
	'envelope_from',
	'to_addresses_json',
	'cc_addresses_json',
	'bcc_addresses_json',
	'reply_to_addresses_json',
	'subject',
	'message_id_header',
	'in_reply_to_header',
	'references_json',
	'headers_json',
	'auth_results',
	'text_body',
	'html_body',
	'raw_mime_key',
	'raw_size',
	'processing_status',
	'classification',
	'classification_reason',
	'provider_message_id',
	'delivery_status',
	'delivery_status_at',
	'error',
	'received_at',
	'sent_at',
	'created_at',
	'updated_at',
].join(', ')

function emailMessagesHasArchivedAt(sql: SqlStorage): boolean {
	return sql
		.exec<{ name: string }>(`PRAGMA table_info('email_messages')`)
		.toArray()
		.some((column) => column.name === 'archived_at')
}

/**
 * Rows copied per `transactionSync` during the v6 rebuild. Bodies travel with
 * each row, so keep batches small enough for DO CPU/transaction limits; a
 * failed mid-migration resumes on the next `initializeMailboxSchema` call.
 */
export const mailboxV6RebuildBatchSize = 25

function tableExists(sql: SqlStorage, name: string): boolean {
	return (
		sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
				name,
			)
			.toArray()[0] != null
	)
}

/**
 * v6 rebuild. `email_message_retention_retries` cascades from
 * `email_messages`, so its rows are parked in a scratch table while the
 * parent is swapped; dropping the parent with live children would delete
 * them. Message copy runs in bounded batches (not one all-row transaction)
 * so large mailboxes do not blow DO limits; schema version is only stamped
 * after the swap completes via the caller.
 */
function rebuildEmailMessagesForSpamAndArchive(storage: DurableObjectStorage) {
	const sql = storage.sql
	const retriesCopy = 'email_message_retention_retries_v6_copy'
	const messagesV6 = 'email_messages_v6'

	storage.transactionSync(() => {
		if (!tableExists(sql, messagesV6)) {
			sql.exec(emailMessagesTableSql(messagesV6, { ifNotExists: false }))
		}
		if (!tableExists(sql, retriesCopy)) {
			sql.exec(
				`CREATE TABLE ${retriesCopy} AS
				SELECT * FROM email_message_retention_retries`,
			)
			sql.exec(`DELETE FROM email_message_retention_retries`)
		}
	})

	for (;;) {
		const copied = storage.transactionSync(() => {
			sql.exec(
				`INSERT INTO ${messagesV6} (${preV6EmailMessageColumns}, archived_at)
				SELECT ${preV6EmailMessageColumns}, NULL
				FROM email_messages
				WHERE id NOT IN (SELECT id FROM ${messagesV6})
				ORDER BY id
				LIMIT ${mailboxV6RebuildBatchSize}`,
			)
			return Number(sql.exec<{ n: number }>(`SELECT changes() AS n`).one().n)
		})
		if (copied === 0) break
	}

	storage.transactionSync(() => {
		const sourceCount = Number(
			sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM email_messages`).one()
				.n,
		)
		const targetCount = Number(
			sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${messagesV6}`).one()
				.n,
		)
		if (sourceCount !== targetCount) {
			throw new Error(
				`Mailbox v6 rebuild count mismatch: source=${sourceCount} target=${targetCount}`,
			)
		}
		sql.exec(`DROP TABLE email_messages`)
		sql.exec(`ALTER TABLE ${messagesV6} RENAME TO email_messages`)
		sql.exec(
			`INSERT INTO email_message_retention_retries
			SELECT * FROM ${retriesCopy}`,
		)
		sql.exec(`DROP TABLE ${retriesCopy}`)
	})
}

function createEmailMessageIndexes(sql: SqlStorage) {
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_created_at
		ON email_messages(created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_created_at_asc
		ON email_messages(created_at ASC, id ASC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_created_at
		ON email_messages(inbox_id, created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_thread_created_at
		ON email_messages(thread_id, created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_message_id_header
		ON email_messages(message_id_header)
		WHERE message_id_header IS NOT NULL`,
	)
	sql.exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider_message_id
		ON email_messages(provider_message_id)
		WHERE direction = 'outbound' AND provider_message_id IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_direction_created_at
		ON email_messages(direction, created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_delivery_status_created_at
		ON email_messages(delivery_status, created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_classification_created_at
		ON email_messages(classification, created_at DESC, id DESC)`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_archived_created_at
		ON email_messages(created_at DESC, id DESC)
		WHERE archived_at IS NOT NULL`,
	)
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_email_messages_raw_mime_key
		ON email_messages(id ASC)
		WHERE raw_mime_key IS NOT NULL`,
	)
}

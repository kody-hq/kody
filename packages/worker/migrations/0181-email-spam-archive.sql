-- System inbox spam + archive: widen system_email_messages.classification to
-- include 'spam' (manual only; receive-time policy still writes accepted or
-- quarantined) and add a nullable archived_at. Existing rows keep their
-- classification and get archived_at NULL.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Dropping
-- the old parent runs its FK actions even with deferred foreign keys:
-- system_email_attachments would CASCADE delete and
-- system_email_delivery_events.message_id would be SET NULL. Snapshot and
-- clear attachments first, record delivery-event links, rebuild, then restore
-- both (0165-style). Row counts are asserted before the batch commits.

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS __migration_assertions;
DROP TABLE IF EXISTS _mig0181_counts;
DROP TABLE IF EXISTS _mig0181_system_email_attachments;
DROP TABLE IF EXISTS _mig0181_system_email_delivery_event_links;
DROP TABLE IF EXISTS system_email_messages_0181;

-- CHECK (0) is an intentionally unreachable assertion trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'system_email_messages.classification has an unregistered value; aborting 0181.'
WHERE EXISTS (
	SELECT 1
	FROM system_email_messages
	WHERE classification NOT IN ('accepted', 'quarantined')
);

CREATE TABLE _mig0181_counts AS
SELECT
	(SELECT COUNT(*) FROM system_email_messages) AS messages,
	(SELECT COUNT(*) FROM system_email_attachments) AS attachments,
	(
		SELECT COUNT(*)
		FROM system_email_delivery_events
		WHERE message_id IS NOT NULL
	) AS linked_events;

CREATE TABLE _mig0181_system_email_attachments AS
SELECT
	id,
	message_id,
	filename,
	content_type,
	content_id,
	disposition,
	size,
	storage_kind,
	storage_key,
	created_at
FROM system_email_attachments;

CREATE TABLE _mig0181_system_email_delivery_event_links AS
SELECT id, message_id
FROM system_email_delivery_events
WHERE message_id IS NOT NULL;

DELETE FROM system_email_attachments;

CREATE TABLE system_email_messages_0181 (
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
		delivery_status IS NULL
		OR delivery_status IN (
			'delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'
		)
	),
	delivery_status_at TEXT,
	classification TEXT NOT NULL DEFAULT 'accepted'
		CHECK (classification IN ('accepted', 'quarantined', 'spam')),
	classification_reason TEXT,
	archived_at TEXT,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL,
	FOREIGN KEY (thread_id) REFERENCES system_email_threads(id) ON DELETE SET NULL,
	FOREIGN KEY (sender_identity_id) REFERENCES email_sender_identities(id)
		ON DELETE SET NULL
);

INSERT INTO system_email_messages_0181 (
	id,
	direction,
	inbox_id,
	thread_id,
	sender_identity_id,
	from_address,
	envelope_from,
	to_addresses_json,
	cc_addresses_json,
	bcc_addresses_json,
	reply_to_addresses_json,
	subject,
	message_id_header,
	in_reply_to_header,
	references_json,
	headers_json,
	auth_results,
	text_body,
	html_body,
	raw_size,
	processing_status,
	provider_message_id,
	error,
	received_at,
	sent_at,
	created_at,
	updated_at,
	raw_mime_key,
	delivery_status,
	delivery_status_at,
	classification,
	classification_reason,
	archived_at
)
SELECT
	id,
	direction,
	inbox_id,
	thread_id,
	sender_identity_id,
	from_address,
	envelope_from,
	to_addresses_json,
	cc_addresses_json,
	bcc_addresses_json,
	reply_to_addresses_json,
	subject,
	message_id_header,
	in_reply_to_header,
	references_json,
	headers_json,
	auth_results,
	text_body,
	html_body,
	raw_size,
	processing_status,
	provider_message_id,
	error,
	received_at,
	sent_at,
	created_at,
	updated_at,
	raw_mime_key,
	delivery_status,
	delivery_status_at,
	classification,
	classification_reason,
	NULL
FROM system_email_messages;

DROP TABLE system_email_messages;
ALTER TABLE system_email_messages_0181 RENAME TO system_email_messages;

CREATE INDEX idx_system_email_messages_created_at
ON system_email_messages(created_at);
CREATE INDEX idx_system_email_messages_inbox_created_at
ON system_email_messages(inbox_id, created_at);
CREATE INDEX idx_system_email_messages_thread_created_at
ON system_email_messages(thread_id, created_at);
CREATE INDEX idx_system_email_messages_message_id_header
ON system_email_messages(message_id_header);
CREATE UNIQUE INDEX idx_system_email_messages_provider_message_id
ON system_email_messages(provider_message_id)
WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;
CREATE INDEX idx_system_email_messages_quarantined_created_at
ON system_email_messages(created_at)
WHERE classification = 'quarantined';
CREATE INDEX idx_system_email_messages_spam_created_at
ON system_email_messages(created_at)
WHERE classification = 'spam';
CREATE INDEX idx_system_email_messages_archived_created_at
ON system_email_messages(created_at)
WHERE archived_at IS NOT NULL;

INSERT INTO system_email_attachments (
	id,
	message_id,
	filename,
	content_type,
	content_id,
	disposition,
	size,
	storage_kind,
	storage_key,
	created_at
)
SELECT
	id,
	message_id,
	filename,
	content_type,
	content_id,
	disposition,
	size,
	storage_kind,
	storage_key,
	created_at
FROM _mig0181_system_email_attachments;

UPDATE system_email_delivery_events
SET message_id = (
	SELECT link.message_id
	FROM _mig0181_system_email_delivery_event_links AS link
	WHERE link.id = system_email_delivery_events.id
)
WHERE id IN (
	SELECT id FROM _mig0181_system_email_delivery_event_links
);

INSERT INTO __migration_assertions (message)
SELECT 'system email row counts changed during the 0181 rebuild; aborting.'
WHERE (SELECT messages FROM _mig0181_counts)
		<> (SELECT COUNT(*) FROM system_email_messages)
	OR (SELECT attachments FROM _mig0181_counts)
		<> (SELECT COUNT(*) FROM system_email_attachments)
	OR (SELECT linked_events FROM _mig0181_counts)
		<> (
			SELECT COUNT(*)
			FROM system_email_delivery_events
			WHERE message_id IS NOT NULL
		);

DROP TABLE _mig0181_system_email_delivery_event_links;
DROP TABLE _mig0181_system_email_attachments;
DROP TABLE _mig0181_counts;
DROP TABLE __migration_assertions;

-- Messages that exhausted their source queue's retries. The production
-- dead-letter-queue consumer parks each one here so admins can peek at
-- redacted metadata, replay it to its source queue, or ack/purge it
-- (docs/contributing/dead-letter-queues.md).
--
-- `body_json` holds the original message body only so replay can resend it;
-- it is never returned by any admin read. NULL when the body could not be
-- serialized as JSON (such messages can be acked but not replayed).
CREATE TABLE dead_letter_messages (
	dead_letter_queue TEXT NOT NULL,
	message_id TEXT NOT NULL,
	source_queue TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'parked' CHECK (status IN ('parked', 'replaying')),
	body_json TEXT,
	payload_type TEXT NOT NULL,
	payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
	top_level_keys_json TEXT NOT NULL,
	top_level_key_count INTEGER NOT NULL CHECK (top_level_key_count >= 0),
	message_kind TEXT,
	stable_ids_json TEXT NOT NULL,
	attempts INTEGER NOT NULL,
	enqueued_at_ms INTEGER NOT NULL,
	parked_at_ms INTEGER NOT NULL,
	claimed_at_ms INTEGER,
	PRIMARY KEY (dead_letter_queue, message_id)
);

CREATE INDEX dead_letter_messages_queue_enqueued_idx
	ON dead_letter_messages (dead_letter_queue, enqueued_at_ms, message_id);

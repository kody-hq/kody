-- RFC Message-ID of the submitter acknowledgement email (Cloudflare Email Sending).
-- Used so later feedback emails can set In-Reply-To / References for client threading.
-- NULL for rows whose ack was sent before this column existed (or when the provider did not return an id).

ALTER TABLE platform_feedback ADD COLUMN acknowledgement_message_id TEXT
	CHECK (
		acknowledgement_message_id IS NULL OR (
			length(acknowledgement_message_id) BETWEEN 3 AND 998
		)
	);

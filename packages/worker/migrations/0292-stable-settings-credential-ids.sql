ALTER TABLE secret_provider_bindings ADD COLUMN door_credential_id TEXT;

UPDATE secret_provider_bindings AS binding
SET door_credential_id = (
	SELECT entry.id
	FROM secret_buckets AS bucket
	JOIN secret_entries AS entry ON entry.bucket_id = bucket.id
	WHERE bucket.user_id = binding.user_id
		AND bucket.scope = 'user' AND bucket.binding_key = ''
		AND entry.name = binding.door_secret_name
		AND entry.kind = 'secret'
		AND (bucket.expires_at IS NULL OR bucket.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (entry.expires_at IS NULL OR entry.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND bucket.deleted_at IS NULL AND entry.deleted_at IS NULL
)
WHERE deleted_at IS NULL;

ALTER TABLE webhook_endpoints ADD COLUMN hmac_credential_id TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN previous_hmac_credential_id TEXT;

UPDATE webhook_endpoints AS endpoint
SET hmac_credential_id = (
	SELECT CASE WHEN entry.kind = 'secret' THEN entry.id END
	FROM secret_buckets AS bucket
	JOIN secret_entries AS entry ON entry.bucket_id = bucket.id
	WHERE bucket.user_id = endpoint.user_id
		AND ((bucket.scope = 'package' AND bucket.binding_key = endpoint.package_id)
			OR (bucket.scope = 'user' AND bucket.binding_key = ''))
		AND entry.name = endpoint.hmac_secret_name
		AND (bucket.expires_at IS NULL OR bucket.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND (entry.expires_at IS NULL OR entry.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		AND bucket.deleted_at IS NULL AND entry.deleted_at IS NULL
	ORDER BY CASE bucket.scope WHEN 'package' THEN 0 ELSE 1 END
	LIMIT 1
)
WHERE deleted_at IS NULL AND hmac_secret_name IS NOT NULL;

-- Older grace snapshots are not live name lookups. Keep the ID when the
-- snapshot uses the current label.
UPDATE webhook_endpoints
SET previous_hmac_credential_id = hmac_credential_id
WHERE deleted_at IS NULL AND previous_hmac_secret_name = hmac_secret_name;

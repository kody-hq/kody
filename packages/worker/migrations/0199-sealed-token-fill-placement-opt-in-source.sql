-- A Key saved from a sealed token (secretSet sealed_token, ADR 0068
-- 2026-10-28) keeps the body placement the sealed token had. Record that
-- opt-in as 'sealed_token' so it is not mistaken for the owner's own choice.
CREATE TABLE credential_fill_placement_opt_ins_next (
	credential_id TEXT PRIMARY KEY NOT NULL,
	query INTEGER NOT NULL DEFAULT 0 CHECK (query IN (0, 1)),
	path INTEGER NOT NULL DEFAULT 0 CHECK (path IN (0, 1)),
	body INTEGER NOT NULL DEFAULT 0 CHECK (body IN (0, 1)),
	source TEXT NOT NULL CHECK (source IN ('owner', 'observed', 'sealed_token')),
	updated_at TEXT NOT NULL
);

INSERT INTO credential_fill_placement_opt_ins_next (
	credential_id, query, path, body, source, updated_at
)
SELECT credential_id, query, path, body, source, updated_at
FROM credential_fill_placement_opt_ins;

DROP TABLE credential_fill_placement_opt_ins;

ALTER TABLE credential_fill_placement_opt_ins_next
	RENAME TO credential_fill_placement_opt_ins;

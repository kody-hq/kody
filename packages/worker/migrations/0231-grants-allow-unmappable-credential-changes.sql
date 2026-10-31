-- Per-grant opt-in that lets a collaborator change or publish a package whose
-- credentials are unmappable (publisher-supplied or shared with visitors).
-- Default 0: such packages are owner-only for changes.
ALTER TABLE grants ADD COLUMN allow_unmappable_credential_changes INTEGER NOT NULL DEFAULT 0;

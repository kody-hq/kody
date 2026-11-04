/**
 * Current `entity_sources` table (migrations through 0250). Test-local
 * schemas use this instead of their own copy, so a column change is one
 * edit here. `entity-sources-test-schema.node.test.ts` fails when it drifts
 * from the migrations.
 */
export const entitySourcesTableSql = `CREATE TABLE IF NOT EXISTS entity_sources (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	entity_kind TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	repo_id TEXT NOT NULL,
	published_commit TEXT,
	indexed_commit TEXT,
	manifest_path TEXT NOT NULL DEFAULT 'kody.json',
	source_root TEXT NOT NULL DEFAULT '/',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_external_check_at TEXT,
	external_check_until TEXT,
	deleted_at TEXT,
	deleting_at TEXT,
	serving_commit TEXT,
	external_check_failed_commit TEXT,
	external_check_failed_at TEXT
)`

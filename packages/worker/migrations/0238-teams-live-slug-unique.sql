-- A deleted team's slug can be reused (teamDelete, issue 3798). The
-- table-level UNIQUE (org_id, slug) counted soft-deleted rows, so this
-- rebuilds teams without it and adds a partial unique index over live rows.
--
-- SQLite cannot drop a table constraint, so this copies into teams_next and
-- swaps, the way 0214 rebuilt grants. Ids, rows, and columns are unchanged.
-- No table references teams by foreign key.
--
-- No access_epoch bump: no team row changes.
--
-- An older Worker keeps working: it never writes deleted_at on teams and
-- already skips deleted teams in every slug lookup.
--
-- Fails closed (nothing applies) when the copy does not match the original
-- row for row.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

CREATE TABLE teams_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	parent_team_id TEXT CHECK (parent_team_id IS NULL),
	created_by_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

INSERT INTO teams_next (
	id, org_id, slug, name, description, parent_team_id,
	created_by_user_id, created_at, updated_at, deleted_at
)
SELECT id, org_id, slug, name, description, parent_team_id,
	created_by_user_id, created_at, updated_at, deleted_at
FROM teams;

INSERT INTO __migration_assertions (message)
SELECT 'teams_next does not match teams; aborting 0238.'
WHERE EXISTS (
	SELECT id, org_id, slug, name, description, parent_team_id,
		created_by_user_id, created_at, updated_at, deleted_at
	FROM teams
	EXCEPT
	SELECT id, org_id, slug, name, description, parent_team_id,
		created_by_user_id, created_at, updated_at, deleted_at
	FROM teams_next
)
OR (SELECT COUNT(*) FROM teams) != (SELECT COUNT(*) FROM teams_next);

DROP TABLE teams;
ALTER TABLE teams_next RENAME TO teams;

CREATE UNIQUE INDEX teams_live_org_slug ON teams (org_id, slug)
	WHERE deleted_at IS NULL;

CREATE INDEX teams_org ON teams (org_id);

DROP TABLE __migration_assertions;

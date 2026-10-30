import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countCommunityForksByListingIds,
	listPrivateCommunityForkCandidatesForPerson,
	listPublicCommunityForks,
} from './repo.ts'

function createSeededDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY, slug TEXT NOT NULL, display_name TEXT,
			avatar_key TEXT, deleted_at TEXT, suspended_at TEXT
		);
		CREATE TABLE org_memberships (
			org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, deleted_at TEXT
		);
		CREATE TABLE grants (
			id TEXT PRIMARY KEY, org_id TEXT NOT NULL, subject_type TEXT NOT NULL,
			subject_id TEXT NOT NULL, deleted_at TEXT, expires_at TEXT
		);
		CREATE TABLE teams (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, deleted_at TEXT);
		CREATE TABLE team_members (
			team_id TEXT NOT NULL, user_id TEXT NOT NULL, deleted_at TEXT
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kody_id TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL,
			is_private INTEGER NOT NULL DEFAULT 1, hidden INTEGER NOT NULL DEFAULT 0,
			deleted_at TEXT
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, published_commit TEXT,
			deleted_at TEXT
		);
		CREATE TABLE community_forks (
			id TEXT PRIMARY KEY, listing_id TEXT NOT NULL,
			forker_user_id TEXT NOT NULL, forked_package_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		INSERT INTO orgs (id, slug, display_name, suspended_at) VALUES
			('org-pub', 'alice', 'Alice', NULL),
			('org-priv', 'bob', NULL, NULL),
			('org-team', 'acme', 'Acme', NULL),
			('org-suspended', 'gone', NULL, '2026-01-01');
		INSERT INTO org_memberships (org_id, user_id, role) VALUES
			('org-priv', 'person-bob', 'owner');
		INSERT INTO teams (id, org_id) VALUES ('team-1', 'org-team');
		INSERT INTO team_members (team_id, user_id) VALUES ('team-1', 'person-carol');
		INSERT INTO grants (id, org_id, subject_type, subject_id) VALUES
			('grant-1', 'org-team', 'team', 'team-1');
		INSERT INTO saved_packages (id, user_id, kody_id, source_id, is_private, hidden, deleted_at) VALUES
			('pkg-public', 'org-pub', 'ship-pr', 'src-public', 0, 0, NULL),
			('pkg-private', 'org-priv', 'ship-pr', 'src-private', 1, 0, NULL),
			('pkg-hidden', 'org-team', 'ship-pr', 'src-hidden', 0, 1, NULL),
			('pkg-deleted', 'org-pub', 'old-fork', 'src-deleted', 0, 0, '2026-02-01'),
			('pkg-suspended', 'org-suspended', 'ship-pr', 'src-suspended', 0, 0, NULL);
		INSERT INTO entity_sources (id, user_id, published_commit) VALUES
			('src-public', 'org-pub', 'abc123');
		INSERT INTO community_forks (id, listing_id, forker_user_id, forked_package_id, created_at) VALUES
			('fork-public', 'listing-1', 'org-pub', 'pkg-public', '2026-10-01'),
			('fork-private', 'listing-1', 'org-priv', 'pkg-private', '2026-10-02'),
			('fork-hidden', 'listing-1', 'org-team', 'pkg-hidden', '2026-10-03'),
			('fork-deleted', 'listing-1', 'org-pub', 'pkg-deleted', '2026-10-04'),
			('fork-suspended', 'listing-1', 'org-suspended', 'pkg-suspended', '2026-10-05'),
			('fork-inert', 'listing-1', 'org-pub', 'pkg-not-published', '2026-10-06');
	`)
	return createD1FromSqlite(sqlite)
}

test('public fork count and list leave out private, hidden, deleted, suspended and inert forks', async () => {
	const db = createSeededDb()
	await expect(
		countCommunityForksByListingIds(db, ['listing-1', 'listing-empty']),
	).resolves.toEqual({ 'listing-1': 1, 'listing-empty': 0 })
	await expect(
		listPublicCommunityForks(db, { listingId: 'listing-1', limit: 10 }),
	).resolves.toEqual([
		{
			forkId: 'fork-public',
			createdAt: '2026-10-01',
			packageId: 'pkg-public',
			kodyId: 'ship-pr',
			description: '',
			isPrivate: false,
			ownerId: 'org-pub',
			ownerSlug: 'alice',
			ownerDisplayName: 'Alice',
			ownerAvatarKey: null,
			publishedCommit: 'abc123',
		},
	])
})

test('private fork candidates only reach members and grantees of the forking org', async () => {
	const db = createSeededDb()
	const candidateIds = async (personId: string) =>
		(
			await listPrivateCommunityForkCandidatesForPerson(db, {
				listingId: 'listing-1',
				personId,
			})
		).map((fork) => fork.forkId)
	await expect(candidateIds('person-bob')).resolves.toEqual(['fork-private'])
	await expect(candidateIds('person-carol')).resolves.toEqual(['fork-hidden'])
	await expect(candidateIds('person-outsider')).resolves.toEqual([])
})

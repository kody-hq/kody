import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0202-integration-app-owner.sql'

function migrationSql(name: string) {
	return readFileSync(new URL(name, migrationsDirectory), 'utf8')
}

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: true,
	})
	sqlite.exec('PRAGMA foreign_keys = OFF')
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < migrationFileName)
		.sort()) {
		sqlite.exec(migrationSql(name))
	}
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(`
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES
			('org-a', 'github', 'github', 'client-a', 'https://github.com/login/oauth/access_token', 'confidential'),
			('org-team', 'github', 'github', 'client-team', 'https://github.com/login/oauth/access_token', 'confidential');
		INSERT INTO platform_oauth_apps (slug, provider, client_id, token_url, authorize_url, flow)
		VALUES ('google', 'google', 'platform-client', 'https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/v2/auth', 'pkce');
		INSERT INTO user_integrations (
			user_id, name, app_slug, access_token_encrypted, refresh_token_encrypted,
			connected_at, scopes_json, required_hosts_json, usage_mode,
			allowed_packages_json, connected_by_user_id, placement_json, provider
		) VALUES (
			'org-a', 'github', 'github', 'ct-access', 'ct-refresh',
			'2026-10-01T00:00:00Z', '["repo"]', '["api.github.com"]', 'packages',
			'["pkg-1"]', 'person-a', '{"header":true}', 'github'
		);
		INSERT INTO user_integrations (user_id, name, platform_app_slug, access_token_encrypted)
		VALUES ('org-a', 'google', 'google', 'ct-google');
	`)
	return sqlite
}

function allRows(sqlite: DatabaseSync) {
	return sqlite
		.prepare('SELECT * FROM user_integrations ORDER BY user_id, name')
		.all() as Array<Record<string, unknown>>
}

test('0202 keeps every existing row and column value and sets app_owner_id', () => {
	const sqlite = databaseBeforeMigration()
	const before = allRows(sqlite)
	sqlite.exec(migrationSql(migrationFileName))
	const after = allRows(sqlite)
	expect(after).toHaveLength(before.length)
	for (const [index, row] of after.entries()) {
		const { app_owner_id, ...rest } = row
		expect(rest).toEqual(before[index])
		expect(app_owner_id).toBe(row.app_slug ? row.user_id : null)
	}
	expect(
		sqlite.prepare('PRAGMA foreign_key_check(user_integrations)').all(),
	).toEqual([])
})

test('0202 keeps platform apps, defaults app_owner_id, and enforces the app FK', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(migrationSql(migrationFileName))
	// Old Worker inserts omit app_owner_id; the trigger fills in the owner.
	sqlite.exec(
		`INSERT INTO user_integrations (user_id, name, app_slug) VALUES ('org-a', 'github-2', 'github')`,
	)
	expect(
		sqlite
			.prepare(
				`SELECT app_owner_id, id FROM user_integrations WHERE name = 'github-2'`,
			)
			.get(),
	).toMatchObject({ app_owner_id: 'org-a', id: expect.any(String) })
	sqlite.exec(
		`INSERT INTO user_integrations (user_id, name, platform_app_slug) VALUES ('org-b', 'google', 'google')`,
	)
	expect(
		sqlite
			.prepare(
				`SELECT app_owner_id FROM user_integrations WHERE user_id = 'org-b'`,
			)
			.get(),
	).toEqual({ app_owner_id: null })
	// A personal connection on the team org's app.
	sqlite.exec(
		`INSERT INTO user_integrations (user_id, name, app_slug, app_owner_id) VALUES ('org-b', 'github', 'github', 'org-team')`,
	)
	expect(() =>
		sqlite.exec(
			`INSERT INTO user_integrations (user_id, name, app_slug, app_owner_id) VALUES ('org-b', 'github-again', 'github', 'org-team')`,
		),
	).toThrow(/UNIQUE/)
	expect(() =>
		sqlite.exec(
			`INSERT INTO user_integrations (user_id, name, app_slug, app_owner_id) VALUES ('org-c', 'github', 'github', 'org-missing')`,
		),
	).toThrow(/FOREIGN KEY/)
	expect(() =>
		sqlite.exec(
			`DELETE FROM user_oauth_apps WHERE user_id = 'org-team' AND slug = 'github'`,
		),
	).toThrow(/FOREIGN KEY/)
	expect(() =>
		sqlite.exec(
			`INSERT INTO user_integrations (user_id, name, app_slug, platform_app_slug) VALUES ('org-d', 'both', 'github', 'google')`,
		),
	).toThrow(/CHECK/)
})

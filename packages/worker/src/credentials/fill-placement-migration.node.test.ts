import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0162-credential-fill-placement.sql'

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql') && entry < migrationFileName)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-a', 'org-a', 'user', '');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value)
		VALUES ('bucket-a', 'OPENAI_KEY', 'ct');
		INSERT INTO user_integrations (user_id, name, app_slug, access_token_encrypted)
		VALUES ('org-a', 'github', 'my-github', 'ct');
		INSERT INTO secret_provider_bindings (user_id, provider_id, package_id, door_secret_name)
		VALUES ('org-a', '1password', 'pkg-op', 'VAULT_DOOR');
	`)
	return sqlite
}

test('0162 adds nullable placement_json so existing credentials stay anywhere', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
	const secret = sqlite
		.prepare(
			`SELECT placement_json FROM secret_entries WHERE name = 'OPENAI_KEY'`,
		)
		.get() as { placement_json: string | null }
	const integration = sqlite
		.prepare(
			`SELECT placement_json FROM user_integrations WHERE name = 'github'`,
		)
		.get() as { placement_json: string | null }
	const vault = sqlite
		.prepare(
			`SELECT placement_json FROM secret_provider_bindings WHERE provider_id = '1password'`,
		)
		.get() as { placement_json: string | null }
	expect(secret.placement_json).toBeNull()
	expect(integration.placement_json).toBeNull()
	expect(vault.placement_json).toBeNull()

	sqlite.exec(
		`UPDATE secret_entries SET placement_json = '{"headers":true}' WHERE name = 'OPENAI_KEY'`,
	)
	expect(
		(
			sqlite
				.prepare(
					`SELECT placement_json FROM secret_entries WHERE name = 'OPENAI_KEY'`,
				)
				.get() as { placement_json: string }
		).placement_json,
	).toBe('{"headers":true}')
})

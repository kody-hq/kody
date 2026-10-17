import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { upsertIntegrationConnection } from '#worker/integrations/repo.ts'
import { upsertSecretProviderBinding } from '#mcp/secrets/secret-providers/repo.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0111-credential-provider-inject-source.sql'
const bearerInject = {
	kind: 'header',
	name: 'Authorization',
	format: 'Bearer {value}',
}

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < migrationFileName)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO platform_oauth_apps (
			slug, provider, client_id, token_url, authorize_url, flow
		) VALUES (
			'kody-google', 'google', 'client', 'https://oauth2.googleapis.com/token',
			'https://accounts.google.com/o/oauth2/auth', 'pkce'
		);
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES ('org-a', 'my-github', 'github', 'client', 'https://github.com/token', 'confidential');
		INSERT INTO user_integrations (user_id, name, app_slug, platform_app_slug, access_token_encrypted)
		VALUES
			('org-a', 'github', 'my-github', NULL, 'ct'),
			('org-a', 'calendar', NULL, 'kody-google', 'ct'),
			('org-a', 'orphan', 'gone-app', NULL, 'ct');
		INSERT INTO user_integrations (user_id, name, app_slug, access_token_encrypted, deleted_at)
		VALUES ('org-a', 'old-github', 'my-github', 'ct', '2026-10-01T00:00:00Z');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-a', 'org-a', 'user', '');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value)
		VALUES ('bucket-a', 'OPENAI_KEY', 'ct');
		INSERT INTO mcp_server_settings (id, user_id, name, url)
		VALUES ('mcp-linear', 'org-a', 'linear', 'https://mcp.linear.app');
		INSERT INTO secret_provider_bindings (user_id, provider_id, package_id, door_secret_name)
		VALUES ('org-a', '1password', 'pkg-op', 'VAULT_DOOR');
	`)
	return sqlite
}

function runMigration(sqlite: DatabaseSync) {
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
}

function fieldsOf(sqlite: DatabaseSync, table: string) {
	return (
		sqlite
			.prepare(
				`SELECT provider, inject_json, source_json FROM ${table} ORDER BY rowid`,
			)
			.all() as Array<{
			provider: string | null
			inject_json: string
			source_json: string
		}>
	).map((row) => ({
		provider: row.provider,
		inject: JSON.parse(row.inject_json),
		source: JSON.parse(row.source_json),
	}))
}

test('0111 backfills integration providers from their OAuth app and defaults inject and source on every credential row', () => {
	const sqlite = databaseBeforeMigration()
	runMigration(sqlite)

	expect(fieldsOf(sqlite, 'user_integrations')).toEqual([
		{ provider: 'github', inject: bearerInject, source: 'stored' },
		{ provider: 'google', inject: bearerInject, source: 'stored' },
		{ provider: null, inject: bearerInject, source: 'stored' },
		{ provider: 'github', inject: bearerInject, source: 'stored' },
	])
	expect(fieldsOf(sqlite, 'secret_entries')).toEqual([
		{ provider: null, inject: bearerInject, source: 'stored' },
	])
	expect(fieldsOf(sqlite, 'mcp_server_settings')).toEqual([
		{ provider: null, inject: bearerInject, source: 'stored' },
	])
	expect(fieldsOf(sqlite, 'secret_provider_bindings')).toEqual([
		{ provider: null, inject: bearerInject, source: { vault: '1password' } },
	])
	expect(() =>
		sqlite.exec(
			`UPDATE secret_entries SET inject_json = 'not json' WHERE name = 'OPENAI_KEY'`,
		),
	).toThrow(/CHECK constraint failed/)
})

test('connecting or reconnecting an integration records its OAuth app provider', async () => {
	const sqlite = databaseBeforeMigration()
	runMigration(sqlite)
	const db = createD1FromSqlite(sqlite)
	const row: Parameters<typeof upsertIntegrationConnection>[0]['row'] = {
		user_id: 'org-a',
		name: 'work',
		app_slug: 'my-github',
		platform_app_slug: null,
		account_label: null,
		description: '',
		scopes_json: '[]',
		required_hosts_json: '[]',
		connected_at: '2026-10-11T00:00:00Z',
		token_refreshed_at: null,
	}
	const providerOf = () =>
		sqlite
			.prepare(`SELECT provider FROM user_integrations WHERE name = 'work'`)
			.get()

	await upsertIntegrationConnection({ db, row })
	expect(providerOf()).toEqual({ provider: 'github' })

	await upsertIntegrationConnection({
		db,
		row: { ...row, app_slug: null, platform_app_slug: 'kody-google' },
	})
	expect(providerOf()).toEqual({ provider: 'google' })
})

test('a vault binding created or rebound after 0111 records its vault as its source', async () => {
	const sqlite = databaseBeforeMigration()
	runMigration(sqlite)
	// Live upserts select placement_json (0161); apply it so the reader matches
	// today's schema without re-running the whole ledger.
	sqlite.exec(
		readFileSync(
			new URL('0161-credential-fill-placement.sql', migrationsDirectory),
			'utf8',
		),
	)
	const db = createD1FromSqlite(sqlite)
	const binding = {
		userId: 'org-a',
		providerId: 'bitwarden',
		packageId: 'pkg-bw',
		doorSecretName: 'BW_DOOR',
		configJson: '{}',
	}
	await upsertSecretProviderBinding(db, binding)
	await upsertSecretProviderBinding(db, { ...binding, packageId: 'pkg-bw-2' })
	expect(fieldsOf(sqlite, 'secret_provider_bindings')).toEqual([
		{ provider: null, inject: bearerInject, source: { vault: '1password' } },
		{ provider: null, inject: bearerInject, source: { vault: 'bitwarden' } },
	])
})

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { localExecuteOrgPermissions } from '#worker/api-tokens/legacy-scope-rewrite.ts'

test('Teams P4 migration 0090 binds credentials and rewrites legacy scopes', () => {
	const migrationsDirectory = new URL('../../migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE api_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL
		);
		CREATE TABLE cli_credential_bootstrap_codes (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL
		);
		CREATE TABLE mcp_agent_sessions (
			do_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL
		);
		CREATE TABLE connection_profiles (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL
		);
	`)
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json) VALUES (?, ?, ?)`,
		)
		.run('tok-1', 'user-1', JSON.stringify(['account:write', 'local-execute']))
	sqlite
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (id, user_id, scopes_json)
			 VALUES (?, ?, ?)`,
		)
		.run('bc-1', 'user-1', JSON.stringify(['account:read', 'local-execute']))
	sqlite
		.prepare(`INSERT INTO mcp_agent_sessions (do_id, user_id) VALUES (?, ?)`)
		.run('do-1', 'user-1')
	sqlite
		.prepare(
			`INSERT INTO connection_profiles (id, user_id, name) VALUES (?, ?, ?)`,
		)
		.run('p-1', 'user-1', 'work')

	sqlite.exec(
		readFileSync(
			new URL('0090-teams-credential-org-binding.sql', migrationsDirectory),
			'utf8',
		),
	)

	const token = sqlite
		.prepare(`SELECT org_id, scopes_json FROM api_tokens WHERE id = ?`)
		.get('tok-1') as { org_id: string; scopes_json: string }
	expect(token.org_id).toBe('user-1')
	expect(JSON.parse(token.scopes_json)).toEqual([
		'billing:read',
		'billing:write',
		'member:read',
		'org:execute',
		'org:read',
		'org:write',
	])

	const bootstrap = sqlite
		.prepare(
			`SELECT org_id, scopes_json FROM cli_credential_bootstrap_codes WHERE id = ?`,
		)
		.get('bc-1') as { org_id: string; scopes_json: string }
	expect(bootstrap.org_id).toBe('user-1')
	expect(JSON.parse(bootstrap.scopes_json)).toEqual([
		'billing:read',
		'member:read',
		'org:execute',
		'org:read',
	])

	expect(
		sqlite
			.prepare(`SELECT org_id FROM mcp_agent_sessions WHERE do_id = ?`)
			.get('do-1'),
	).toEqual({ org_id: 'user-1' })
	expect(
		sqlite
			.prepare(`SELECT org_id FROM connection_profiles WHERE id = ?`)
			.get('p-1'),
	).toEqual({ org_id: 'user-1' })
})

test('migration 0092 restores local-execute parity on org:execute tokens', () => {
	const migrationsDirectory = new URL('../../migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE api_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL,
			created_via TEXT
		);
		CREATE TABLE cli_credential_bootstrap_codes (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL
		);
	`)
	// Post-0090 shape of account:read + local-execute (Pam's token).
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json, created_via)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(
			'tok-local',
			'user-1',
			JSON.stringify([
				'billing:read',
				'member:read',
				'org:execute',
				'org:read',
			]),
			'cli-bootstrap',
		)
	// Post-package:execute bootstrap still missing integration:read.
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json, created_via)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(
			'tok-bootstrap',
			'user-1',
			JSON.stringify(['org:execute', 'org:read', 'package:execute']),
			'cli-bootstrap',
		)
	// Intentional narrow CI token without org:execute stays untouched.
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json, created_via)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(
			'tok-search',
			'user-1',
			JSON.stringify(['org:read', 'search:read']),
			'api',
		)
	// Intentional CapabilityProxy CI token with package:execute already —
	// not a 0090 local-execute rewrite and not cli-bootstrap; leave alone.
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json, created_via)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(
			'tok-ci-narrow',
			'user-1',
			JSON.stringify(['org:execute', 'org:read', 'package:execute']),
			'api',
		)
	sqlite
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (id, user_id, scopes_json)
			 VALUES (?, ?, ?)`,
		)
		.run(
			'bc-1',
			'user-1',
			JSON.stringify(['org:execute', 'org:read', 'package:execute']),
		)

	sqlite.exec(
		readFileSync(
			new URL('0092-local-execute-parity-scopes.sql', migrationsDirectory),
			'utf8',
		),
	)

	// Pending bootstrap codes are intentionally not widened (short TTL /
	// parent-cap). Post-deploy mints get parity from TypeScript defaults.

	const local = JSON.parse(
		(
			sqlite
				.prepare(`SELECT scopes_json FROM api_tokens WHERE id = ?`)
				.get('tok-local') as { scopes_json: string }
		).scopes_json,
	) as Array<string>
	expect(local).toEqual(
		[
			...localExecuteOrgPermissions,
			'billing:read',
			'member:read',
			'org:read',
		].sort(),
	)

	const bootstrap = JSON.parse(
		(
			sqlite
				.prepare(`SELECT scopes_json FROM api_tokens WHERE id = ?`)
				.get('tok-bootstrap') as { scopes_json: string }
		).scopes_json,
	) as Array<string>
	expect(bootstrap).toEqual([...localExecuteOrgPermissions, 'org:read'].sort())

	expect(
		JSON.parse(
			(
				sqlite
					.prepare(`SELECT scopes_json FROM api_tokens WHERE id = ?`)
					.get('tok-search') as { scopes_json: string }
			).scopes_json,
		),
	).toEqual(['org:read', 'search:read'])
	expect(
		JSON.parse(
			(
				sqlite
					.prepare(`SELECT scopes_json FROM api_tokens WHERE id = ?`)
					.get('tok-ci-narrow') as { scopes_json: string }
			).scopes_json,
		),
	).toEqual(['org:execute', 'org:read', 'package:execute'])

	expect(
		JSON.parse(
			(
				sqlite
					.prepare(
						`SELECT scopes_json FROM cli_credential_bootstrap_codes WHERE id = ?`,
					)
					.get('bc-1') as { scopes_json: string }
			).scopes_json,
		),
	).toEqual(['org:execute', 'org:read', 'package:execute'])
})

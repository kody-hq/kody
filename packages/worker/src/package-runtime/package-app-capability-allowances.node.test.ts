import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildCapabilityAllowanceCheck,
	loadPackageAppCapabilityAllowance,
	loadPublishedCapabilityAllowance,
} from './package-app-capability-allowances.ts'

const migrationsUrl = new URL('../../migrations/', import.meta.url)
const seedSql = readFileSync(
	new URL('0226-package-app-capability-allowances.sql', migrationsUrl),
	'utf8',
)
const now = '2026-10-31T00:00:00.000Z'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsUrl)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertApp(
	sqlite: DatabaseSync,
	input: { id: string; name: string; commit: string | null },
) {
	sqlite
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id, published_commit, created_at, updated_at)
			 VALUES (?, 'org-1', 'package', ?, ?, ?, ?, ?)`,
		)
		.run(
			`source-${input.id}`,
			input.id,
			`repo-${input.id}`,
			input.commit,
			now,
			now,
		)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, 'org-1', ?, ?, '', ?)`,
		)
		.run(input.id, input.name, input.id, `source-${input.id}`)
}

function insertFallback(
	sqlite: DatabaseSync,
	input: {
		packageId: string
		callName: string
		kind: string
		visitor?: string
	},
) {
	sqlite
		.prepare(
			`INSERT INTO package_app_authority_fallbacks
			 (day, owner_id, package_id, call_name, difference_kind, visitor_hash, first_seen_at, last_seen_at, observations)
			 VALUES ('2026-10-30', 'org-1', ?, ?, ?, ?, ?, ?, 3)`,
		)
		.run(
			input.packageId,
			input.callName,
			input.kind,
			input.visitor ?? 'visitor-hash',
			now,
			now,
		)
}

test('the seed turns undeclared-capability fallbacks into allowances pinned to the published commit', async () => {
	const { sqlite, db } = createDb()
	insertApp(sqlite, { id: 'pkg-a', name: '@org/a', commit: 'commit-a' })
	insertApp(sqlite, { id: 'pkg-b', name: '@org/b', commit: null })
	insertFallback(sqlite, {
		packageId: 'pkg-a',
		callName: 'secretList',
		kind: 'capability_not_declared',
	})
	insertFallback(sqlite, {
		packageId: 'pkg-a',
		callName: 'secretList',
		kind: 'capability_not_declared',
		visitor: 'other-visitor',
	})
	insertFallback(sqlite, {
		packageId: 'pkg-a',
		callName: 'mcp:home:bond_get_device_state',
		kind: 'capability_not_declared',
	})
	// Not capability gaps, or not something a declaration can cover.
	for (const [callName, kind] of [
		['metaGetCurrentUser', 'identity_email'],
		['emailInboxList', 'permission_denied'],
		['credential.named', 'capability_not_declared'],
		['__kodyIntegrationRuntimeConfig', 'capability_not_declared'],
	] as const) {
		insertFallback(sqlite, { packageId: 'pkg-a', callName, kind })
	}
	// An unpublished app has no version to pin an allowance to.
	insertFallback(sqlite, {
		packageId: 'pkg-b',
		callName: 'secretSet',
		kind: 'capability_not_declared',
	})
	sqlite.exec(seedSql.slice(seedSql.indexOf('INSERT OR IGNORE')))

	expect(
		await loadPackageAppCapabilityAllowance(db, {
			packageId: 'pkg-a',
			publishedCommit: 'commit-a',
		}),
	).toEqual(['mcp:home:bond_get_device_state', 'secretList'])
	// The allowance is for that one version only.
	expect(
		await loadPackageAppCapabilityAllowance(db, {
			packageId: 'pkg-a',
			publishedCommit: 'commit-next',
		}),
	).toEqual([])
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM package_app_capability_allowances WHERE package_id = 'pkg-b'`,
			)
			.get(),
	).toEqual({ n: 0 })

	expect(
		await loadPublishedCapabilityAllowance(db, {
			sourceId: 'source-pkg-a',
			ownerId: null,
			packageName: null,
		}),
	).toEqual(['mcp:home:bond_get_device_state', 'secretList'])
	// A local dev check finds the published version by owner and name.
	expect(
		await loadPublishedCapabilityAllowance(db, {
			sourceId: null,
			ownerId: 'org-1',
			packageName: '@org/a',
		}),
	).toEqual(['mcp:home:bond_get_device_state', 'secretList'])
	// A new publish moves the published commit, so the allowance stops applying.
	sqlite
		.prepare(
			`UPDATE entity_sources SET published_commit = 'commit-next' WHERE id = 'source-pkg-a'`,
		)
		.run()
	expect(
		await loadPublishedCapabilityAllowance(db, {
			sourceId: 'source-pkg-a',
			ownerId: null,
			packageName: null,
		}),
	).toEqual([])
})

test('publish and dev check name exactly what to add to kody.app.capabilities', () => {
	expect(
		buildCapabilityAllowanceCheck({
			allowance: ['secretSet', 'secretList'],
			declared: new Set(['secretList']),
		}),
	).toEqual({
		kind: 'capabilities',
		ok: true,
		message: [
			'Action needed before this publish: your published version calls 1 capability name(s) that `kody.app.capabilities` does not list. Kody lets that published version keep calling them, but the allowance does not carry over to a new version. Once you publish without them, these calls fail.',
			'- `secretSet`',
			'Add them to `kody.app.capabilities` in package.json, for example: "kody": { "app": { "capabilities": ["secretSet"] } }',
		].join('\n'),
	})
	expect(
		buildCapabilityAllowanceCheck({
			allowance: ['secretList'],
			declared: new Set(['secretList']),
		}),
	).toBeNull()
})

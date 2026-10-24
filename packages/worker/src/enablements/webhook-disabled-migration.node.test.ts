import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0180-webhook-disabled-to-enablement-off.sql'

function applyMigrationFile(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:')
	for (const name of readdirSync(migrationsDirectory)
		.filter((entry) => entry.endsWith('.sql'))
		.sort()) {
		if (name >= migrationFileName) continue
		applyMigrationFile(sqlite, name)
	}
	return sqlite
}

function insertOwner(
	db: DatabaseSync,
	input: { id: string; createdAt: string },
) {
	db.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, created_at, updated_at
		) VALUES (?, ?, 'hash', ?, ?, ?)`,
	).run(
		input.id,
		`${input.id}@example.com`,
		input.id,
		input.createdAt,
		input.createdAt,
	)
	db.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES ('org-1', ?, 'owner', ?)`,
	).run(input.id, input.createdAt)
}

function insertEndpoint(
	db: DatabaseSync,
	input: {
		id: string
		orgId?: string
		webhookName?: string
		enabled: 0 | 1
		deletedAt?: string | null
	},
) {
	db.prepare(
		`INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash, enabled,
			created_at, rotated_at, deleted_at
		) VALUES (?, ?, 'pkg-1', ?, 'hash', ?, '2026-10-01T00:00:00.000Z',
			'2026-10-01T00:00:00.000Z', ?)`,
	).run(
		input.id,
		input.orgId ?? 'org-1',
		input.webhookName ?? 'orders',
		input.enabled,
		input.deletedAt ?? null,
	)
}

function insertEnablement(
	db: DatabaseSync,
	input: { id: string; endpointId: string; state: 'on' | 'paused' | 'off' },
) {
	db.prepare(
		`INSERT INTO enablements (
			id, org_id, package_id, trigger_kind, trigger_name, instance_id,
			enabler_user_id, state, origin, enabled_at, updated_at
		) VALUES (?, 'org-1', 'pkg-1', 'webhook', 'orders', ?, 'owner-1', ?,
			'enabled', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
	).run(input.id, input.endpointId, input.state)
}

test('0180 moves disabled live webhook endpoints to off enablements', () => {
	const sqlite = databaseBeforeMigration()
	insertOwner(sqlite, { id: 'owner-1', createdAt: '2026-10-01T00:00:00.000Z' })

	insertEndpoint(sqlite, {
		id: 'off-on',
		webhookName: 'off-on-hook',
		enabled: 0,
	})
	insertEnablement(sqlite, { id: 'on-row', endpointId: 'off-on', state: 'on' })
	insertEndpoint(sqlite, {
		id: 'off-paused',
		webhookName: 'off-paused-hook',
		enabled: 0,
	})
	insertEnablement(sqlite, {
		id: 'paused-row',
		endpointId: 'off-paused',
		state: 'paused',
	})
	insertEndpoint(sqlite, {
		id: 'off-no-row',
		webhookName: 'orders',
		enabled: 0,
	})
	insertEndpoint(sqlite, {
		id: 'off-existing-off',
		webhookName: 'off-existing-off-hook',
		enabled: 0,
	})
	insertEnablement(sqlite, {
		id: 'already-off-row',
		endpointId: 'off-existing-off',
		state: 'off',
	})
	insertEndpoint(sqlite, {
		id: 'enabled-on',
		webhookName: 'enabled-on-hook',
		enabled: 1,
	})
	insertEnablement(sqlite, {
		id: 'enabled-row',
		endpointId: 'enabled-on',
		state: 'on',
	})
	insertEndpoint(sqlite, {
		id: 'enabled-no-row',
		webhookName: 'enabled-no-row-hook',
		enabled: 1,
	})
	insertEndpoint(sqlite, {
		id: 'deleted-off',
		webhookName: 'deleted-off-hook',
		enabled: 0,
		deletedAt: '2026-10-02T00:00:00.000Z',
	})
	insertEndpoint(sqlite, {
		id: 'ownerless-off',
		orgId: 'org-no-owner',
		webhookName: 'ownerless-off-hook',
		enabled: 0,
	})

	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)

	expect(
		sqlite
			.prepare(
				`SELECT id, state, origin, enabler_user_id, trigger_name, enabled_at,
					disabled_at, updated_at
				 FROM enablements WHERE instance_id = 'off-on'`,
			)
			.get(),
	).toMatchObject({
		id: 'on-row',
		state: 'off',
		origin: 'enabled',
		disabled_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
		updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
	})
	expect(
		sqlite
			.prepare(`SELECT state FROM enablements WHERE instance_id = 'off-paused'`)
			.get(),
	).toEqual({ state: 'off' })

	expect(
		sqlite
			.prepare(
				`SELECT id, org_id, package_id, trigger_kind, trigger_name, instance_id,
					enabler_user_id, state, origin, enabled_at, disabled_at, updated_at
				 FROM enablements WHERE instance_id = 'off-no-row'`,
			)
			.get(),
	).toMatchObject({
		id: 'migrated-webhook-off-off-no-row',
		org_id: 'org-1',
		package_id: 'pkg-1',
		trigger_kind: 'webhook',
		trigger_name: 'orders',
		instance_id: 'off-no-row',
		enabler_user_id: 'owner-1',
		state: 'off',
		origin: 'migrated',
		enabled_at: '2026-10-01T00:00:00.000Z',
		disabled_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
		updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
	})
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM enablements
				 WHERE instance_id = 'off-existing-off'`,
			)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite
			.prepare(`SELECT state FROM enablements WHERE instance_id = 'enabled-on'`)
			.get(),
	).toEqual({ state: 'on' })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM enablements WHERE instance_id = 'enabled-no-row'`,
			)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM enablements WHERE instance_id = 'deleted-off'`,
			)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM enablements WHERE instance_id = 'ownerless-off'`,
			)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE type = 'index' AND name = 'enablements_webhook_instance_all'`,
			)
			.get(),
	).toMatchObject({
		sql: expect.stringContaining(
			'ON enablements (org_id, trigger_kind, instance_id)',
		),
	})
})

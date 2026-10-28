import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	effectiveFillPlacement,
	enforceFillPlacement,
	resolveEffectiveFillPlacement,
} from './fill-placement-enforcement.ts'
import {
	readFillPlacementOptIn,
	recordOwnerFillPlacementOptIn,
} from './fill-placement-opt-ins.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

vi.mock('cloudflare:workers', () => ({
	waitUntil: (promise: Promise<unknown>) => {
		void promise
	},
}))

const none = { query: false, path: false, body: false }

function migratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('a legacy credential narrows to headers plus opted-in parts', () => {
	expect(effectiveFillPlacement(null, none)).toEqual({ headers: true })
	expect(effectiveFillPlacement(null, { ...none, query: true })).toEqual({
		headers: true,
		query: true,
	})
})

test('query, path, and body need both the stored part and an opt-in', () => {
	expect(
		effectiveFillPlacement({ headers: ['X-Api-Key'], body: true }, none),
	).toEqual({ headers: ['X-Api-Key'] })
	expect(
		effectiveFillPlacement(
			{ headers: true, body: true },
			{ ...none, body: true, path: true },
		),
	).toEqual({ headers: true, body: true })
	expect(effectiveFillPlacement({ body: true }, none)).toEqual({})
})

test('headers-only placement skips the opt-in read', async () => {
	const db = { prepare: vi.fn() } as unknown as D1Database
	await expect(
		resolveEffectiveFillPlacement({
			db,
			credentialId: 'cred-1',
			stored: { headers: true },
		}),
	).resolves.toEqual({ headers: true })
	expect(db.prepare).not.toHaveBeenCalled()
})

test('an owner opt-in records exactly the saved parts', async () => {
	const db = migratedDb()
	await recordOwnerFillPlacementOptIn({
		db,
		credentialId: 'cred-1',
		placement: { headers: true, query: true, body: true },
	})
	expect(await readFillPlacementOptIn(db, 'cred-1')).toEqual({
		query: true,
		path: false,
		body: true,
	})
	await recordOwnerFillPlacementOptIn({
		db,
		credentialId: 'cred-1',
		placement: { headers: true },
	})
	expect(await readFillPlacementOptIn(db, 'cred-1')).toEqual(none)
	await expect(
		resolveEffectiveFillPlacement({
			db,
			credentialId: 'cred-1',
			stored: { headers: true, query: true },
		}),
	).resolves.toEqual({ headers: true })
})

test('enforcement refuses a part outside the placement and names it', () => {
	const env = { APP_DB: {} as D1Database }
	expect(() =>
		enforceFillPlacement({
			env,
			credentialName: 'apiKey',
			credentialId: null,
			slot: 'apiKey',
			placement: { headers: true },
			sites: [{ part: 'header', name: 'authorization' }],
			surface: 'placeholder',
		}),
	).not.toThrow()
	let refused: unknown
	try {
		enforceFillPlacement({
			env,
			credentialName: 'apiKey',
			credentialId: null,
			slot: 'apiKey',
			placement: { headers: true },
			sites: [{ part: 'header', name: 'authorization' }, { part: 'body' }],
			surface: 'placeholder',
		})
	} catch (error) {
		refused = error
	}
	expect(refused).toBeInstanceOf(SecretPlacementError)
	const message = (refused as Error).message
	expect(message).toContain('apiKey')
	expect(message).toContain('body')
	expect(message).toContain('credential page')
	expect(message).toContain('slot "apiKey"')
})

test('migration 0195 opts legacy credentials in to the parts they were seen filled into', () => {
	const migrations = new URL('../../migrations/', import.meta.url)
	const target = '0195-credential-fill-placement-opt-ins.sql'
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrations)
		.filter((entry) => entry.endsWith('.sql') && entry < target)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO credential_fill_placement_observations
			(credential_id, filled_last_seen_json, would_block_last_seen_json, updated_at)
		VALUES
			('cred-query', '{"headers":"t","query":"t"}', '{}', 't'),
			('cred-headers', '{"headers":"t"}', '{"body":"t"}', 't');
	`)
	sqlite.exec(readFileSync(new URL(target, migrations), 'utf8'))
	expect(
		sqlite
			.prepare(
				`SELECT credential_id, query, path, body, source
				 FROM credential_fill_placement_opt_ins`,
			)
			.all(),
	).toEqual([
		{
			credential_id: 'cred-query',
			query: 1,
			path: 0,
			body: 0,
			source: 'observed',
		},
	])
})

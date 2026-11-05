import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	acknowledgmentState,
	needsAcknowledgment,
	recordAcknowledgment,
} from './acknowledgments.ts'
import { acknowledgmentRequiredText } from './routing.ts'
import { getExecutionContext } from './store.ts'

const orgId = 'org_acme'
const now = '2026-11-04T00:00:00.000Z'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
			public_key_jwk, thumbprint, created_at, grant_json, grant_version, login_kind, login_user_id)
		VALUES ('ec_mac', '${orgId}', 'user_op', 0, 'mac', '{}', 'thumb', '${now}', '{}', 1, 'person', 'user_op'),
		       ('ec_pi', '${orgId}', 'user_op', 0, 'pi', '{}', 'thumb2', '${now}', '{}', 1, 'person', 'user_op');
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
		VALUES ('${orgId}', 'acme', 0, '${now}', '${now}');
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
		VALUES ('${orgId}', 'user_op', 'member', '${now}'),
		       ('${orgId}', 'user_other', 'member', '${now}'),
		       ('${orgId}', 'user_friend', 'member', '${now}'),
		       ('${orgId}', 'user_second', 'member', '${now}');
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function row(db: D1Database, id = 'ec_mac') {
	return (await getExecutionContext(db, id))!
}

async function acknowledge(db: D1Database, userId: string, id = 'ec_mac') {
	const state = await acknowledgmentState(db, await row(db, id), orgId, userId)
	if (!state.required) throw new Error('expected an acknowledgment')
	return await recordAcknowledgment(db, {
		row: await row(db, id),
		orgId,
		userId,
		fingerprint: state.fingerprint,
	})
}

test('the operator and the box login never acknowledge; everyone else does once per context', async () => {
	const { sqlite, db } = setup()
	expect(needsAcknowledgment(await row(db), 'user_op')).toBe(false)
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_op'),
	).toEqual({ required: false, acknowledgedAt: null })
	sqlite.exec(
		`UPDATE execution_contexts SET login_user_id = 'user_other' WHERE id = 'ec_mac'`,
	)
	expect(needsAcknowledgment(await row(db), 'user_other')).toBe(false)
	expect(needsAcknowledgment(await row(db), 'user_friend')).toBe(true)

	const first = await acknowledgmentState(
		db,
		await row(db),
		orgId,
		'user_friend',
	)
	expect(first).toMatchObject({ required: true, reason: 'first_run' })
	expect(await acknowledge(db, 'user_friend')).toBe('acknowledged')
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_friend'),
	).toMatchObject({ required: false })
	// Per person and per context.
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_second'),
	).toMatchObject({ required: true, reason: 'first_run' })
	expect(
		await acknowledgmentState(db, await row(db, 'ec_pi'), orgId, 'user_friend'),
	).toMatchObject({ required: true, reason: 'first_run' })
	// Idempotent: nothing more to acknowledge.
	expect(
		await recordAcknowledgment(db, {
			row: await row(db),
			orgId,
			userId: 'user_friend',
			fingerprint: 'anything',
		}),
	).toBe('not_required')
})

test('a stale fingerprint is refused', async () => {
	const { db } = setup()
	expect(
		await recordAcknowledgment(db, {
			row: await row(db),
			orgId,
			userId: 'user_friend',
			fingerprint: 'stale',
		}),
	).toBe('changed')
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_friend'),
	).toMatchObject({ required: true })
})

test('a new login or new excess needs a new acknowledgment; lost excess does not', async () => {
	const { sqlite, db } = setup()
	expect(await acknowledge(db, 'user_friend')).toBe('acknowledged')

	sqlite.exec(
		`UPDATE org_memberships SET role = 'owner' WHERE user_id = 'user_op'`,
	)
	const gained = await acknowledgmentState(
		db,
		await row(db),
		orgId,
		'user_friend',
	)
	expect(gained).toMatchObject({
		required: true,
		reason: 'new_access',
		entries: [{ permission: 'owner', resource: null }],
	})
	expect(await acknowledge(db, 'user_friend')).toBe('acknowledged')

	sqlite.exec(
		`UPDATE org_memberships SET role = 'member' WHERE user_id = 'user_op'`,
	)
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_friend'),
	).toMatchObject({ required: false })

	sqlite.exec(
		`UPDATE execution_contexts SET login_user_id = 'user_other' WHERE id = 'ec_mac'`,
	)
	expect(
		await acknowledgmentState(db, await row(db), orgId, 'user_friend'),
	).toMatchObject({ required: true, reason: 'login_changed' })
})

test('the refusal says how to acknowledge', () => {
	expect(
		acknowledgmentRequiredText({
			name: 'mac',
			href: 'https://kody.example/acme/execution-contexts/ec_mac',
		}),
	).toBe(
		'acknowledgment_required: before your first run here, acknowledge what this machine runs as (its login and any access it has that you lack). Open https://kody.example/acme/execution-contexts/ec_mac and choose Acknowledge, or run `kody context acknowledge mac` in a terminal signed in as yourself',
	)
})

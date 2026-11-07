import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	fingerprintHttpApplyDestination,
	fingerprintHttpApplyDestinationLegacy,
	requireWebhookApplyDestinationGrantOrPending,
	toHttpApplyDestinationSnapshot,
} from './apply-destination-approval.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0123-webhook-apply-destination-credential-ids.sql'

function sha256Hex(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

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
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
		VALUES ('org-a', 'org-a', 1, '2026-10-01', '2026-10-01');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-a', 'org-a', 'user', '');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value, allowed_hosts, allowed_packages)
		VALUES
			('cred-hooks', 'bucket-a', 'hooksToken', 'ct', '[]', '[]'),
			('cred-other', 'bucket-a', 'otherToken', 'ct', '[]', '[]');
		INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at
		) VALUES (
			'ep-1', 'org-a', 'pkg-1', 'hook', 'hash', '2026-10-01', '2026-10-01'
		);
	`)
	return sqlite
}

function destinationJson(input: {
	secretName?: string | null
	credentialId?: string | null
	body?: string
}) {
	const secretName = input.secretName ?? null
	const snapshot = {
		method: 'POST',
		url: 'https://hooks.example/register',
		headers: [] as Array<{ name: string; value: string }>,
		body: input.body ?? '{"url":"{{webhookUrl}}"}',
		secretName,
		integration: null,
		credentialId: input.credentialId ?? null,
		injectionSites: ['body'],
		auth: secretName ? `secretName=${secretName}` : 'none',
	}
	return JSON.stringify(snapshot)
}

function legacyFingerprint(
	secretName: string | null,
	body = '{"url":"{{webhookUrl}}"}',
) {
	return sha256Hex(
		JSON.stringify({
			method: 'POST',
			url: 'https://hooks.example/register',
			headers: [],
			body,
			secretName,
			integration: null,
		}),
	)
}

function insertLegacyGrant(
	sqlite: DatabaseSync,
	input: { fingerprint: string; destinationJson: string },
) {
	sqlite
		.prepare(
			`INSERT INTO webhook_apply_destination_grants (
				user_id, webhook_endpoint_id, destination_fingerprint,
				destination_json, package_id, webhook_name, approved_at
			) VALUES ('org-a', 'ep-1', ?, ?, 'pkg-1', 'hook', '2026-10-01')`,
		)
		.run(input.fingerprint, input.destinationJson)
}

function runMigration(sqlite: DatabaseSync) {
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
}

test('0123 backfills credential ids and drops orphan name-keyed approvals', () => {
	const sqlite = databaseBeforeMigration()
	const liveFingerprint = legacyFingerprint('hooksToken')
	const orphanFingerprint = legacyFingerprint('deletedToken')
	const noAuthFingerprint = legacyFingerprint(null)
	insertLegacyGrant(sqlite, {
		fingerprint: liveFingerprint,
		destinationJson: destinationJson({ secretName: 'hooksToken' }),
	})
	insertLegacyGrant(sqlite, {
		fingerprint: orphanFingerprint,
		destinationJson: destinationJson({ secretName: 'deletedToken' }),
	})
	insertLegacyGrant(sqlite, {
		fingerprint: noAuthFingerprint,
		destinationJson: destinationJson({ secretName: null }),
	})

	runMigration(sqlite)

	const rows = sqlite
		.prepare(
			`SELECT destination_fingerprint, credential_id,
				json_extract(destination_json, '$.credentialId') AS json_credential_id,
				json_extract(destination_json, '$.secretName') AS secret_name
			FROM webhook_apply_destination_grants
			ORDER BY destination_fingerprint`,
		)
		.all() as Array<{
		destination_fingerprint: string
		credential_id: string | null
		json_credential_id: string | null
		secret_name: string | null
	}>

	expect(rows).toHaveLength(2)
	const live = rows.find((row) => row.secret_name === 'hooksToken')
	const noAuth = rows.find((row) => row.secret_name == null)
	expect(live?.credential_id).toBe('cred-hooks')
	expect(live?.json_credential_id).toBe('cred-hooks')
	expect(noAuth?.credential_id).toBeNull()
	expect(rows.some((row) => row.secret_name === 'deletedToken')).toBe(false)
})

test('backfill preserves access; replaced credential under same name needs approval; rotation keeps it', async () => {
	const sqlite = databaseBeforeMigration()
	const destination = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	const legacyFp = await fingerprintHttpApplyDestinationLegacy(destination)
	insertLegacyGrant(sqlite, {
		fingerprint: legacyFp,
		destinationJson: destinationJson({ secretName: 'hooksToken' }),
	})
	runMigration(sqlite)

	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as Pick<Env, 'APP_DB'>
	const afterBackfill = await requireWebhookApplyDestinationGrantOrPending({
		env,
		userId: 'org-a' as never,
		orgSlug: 'org-a',
		handle: 'whh_ep-1',
		destination,
		baseUrl: 'https://heykody.dev',
	})
	expect(afterBackfill.status).toBe('granted')
	const idKeyed = await fingerprintHttpApplyDestination(destination, {
		credentialId: 'cred-hooks',
	})
	expect(afterBackfill.status === 'granted' && afterBackfill.fingerprint).toBe(
		idKeyed,
	)
	expect(afterBackfill.status === 'granted' && afterBackfill.credentialId).toBe(
		'cred-hooks',
	)
	const upgraded = sqlite
		.prepare(
			`SELECT credential_id, destination_fingerprint
			FROM webhook_apply_destination_grants
			WHERE user_id = 'org-a' AND webhook_endpoint_id = 'ep-1'`,
		)
		.get() as { credential_id: string; destination_fingerprint: string }
	expect(upgraded.credential_id).toBe('cred-hooks')
	expect(upgraded.destination_fingerprint).toBe(idKeyed)
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM webhook_apply_destination_grants
				WHERE destination_fingerprint = ?`,
			)
			.get(legacyFp) as { n: number },
	).toEqual({ n: 0 })

	// Value rotation keeps the same credential id and approval.
	sqlite
		.prepare(
			`UPDATE secret_entries SET encrypted_value = 'rotated-ct'
			WHERE id = 'cred-hooks'`,
		)
		.run()
	const afterRotation = await requireWebhookApplyDestinationGrantOrPending({
		env,
		userId: 'org-a' as never,
		orgSlug: 'org-a',
		handle: 'whh_ep-1',
		destination,
		baseUrl: 'https://heykody.dev',
	})
	expect(afterRotation.status).toBe('granted')

	// Replace the credential under the same name: new id, old approval must not transfer.
	sqlite.prepare(`DELETE FROM secret_entries WHERE id = 'cred-hooks'`).run()
	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				id, bucket_id, name, encrypted_value, allowed_hosts, allowed_packages
			) VALUES ('cred-hooks-new', 'bucket-a', 'hooksToken', 'ct-new', '[]', '[]')`,
		)
		.run()
	const afterReplace = await requireWebhookApplyDestinationGrantOrPending({
		env,
		userId: 'org-a' as never,
		orgSlug: 'org-a',
		handle: 'whh_ep-1',
		destination,
		baseUrl: 'https://heykody.dev',
	})
	expect(afterReplace.status).toBe('approval_required')
	if (afterReplace.status === 'approval_required') {
		expect(afterReplace.message).toContain('credential cred-hooks-new')
		expect(afterReplace.destination.credentialId).toBe('cred-hooks-new')
	}
})

test("deleted credential's approvals do not transfer to a later recreate", async () => {
	const sqlite = databaseBeforeMigration()
	const destination = {
		type: 'http' as const,
		url: 'https://hooks.example/register',
		method: 'POST' as const,
		body: '{"url":"{{webhookUrl}}"}',
		secretName: 'hooksToken',
	}
	insertLegacyGrant(sqlite, {
		fingerprint: await fingerprintHttpApplyDestinationLegacy(destination),
		destinationJson: destinationJson({ secretName: 'hooksToken' }),
	})
	sqlite.prepare(`DELETE FROM secret_entries WHERE name = 'hooksToken'`).run()
	runMigration(sqlite)

	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS n FROM webhook_apply_destination_grants`)
			.get() as { n: number },
	).toEqual({ n: 0 })

	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				id, bucket_id, name, encrypted_value, allowed_hosts, allowed_packages
			) VALUES ('cred-hooks-recreated', 'bucket-a', 'hooksToken', 'ct', '[]', '[]')`,
		)
		.run()

	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as Pick<Env, 'APP_DB'>
	const gate = await requireWebhookApplyDestinationGrantOrPending({
		env,
		userId: 'org-a' as never,
		orgSlug: 'org-a',
		handle: 'whh_ep-1',
		destination,
		baseUrl: 'https://heykody.dev',
	})
	expect(gate.status).toBe('approval_required')
	expect(
		toHttpApplyDestinationSnapshot(destination, {
			credentialId: 'cred-hooks-recreated',
		}).credentialId,
	).toBe('cred-hooks-recreated')
})

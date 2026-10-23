/**
 * Deleting one credential removes the grants, pending grant invites, and
 * personal-credential org grants on it, in the same batch, for every
 * credential kind. Grants on the owner's other credentials stay.
 */
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { deleteIntegrationConnection } from '#worker/integrations/repo.ts'
import { deleteMcpServerSettingRow } from '#worker/mcp-client/settings-repo.ts'
import { deleteSecretEntry } from '#worker/mcp/secrets/repo.ts'
import { deleteSecretProviderBinding } from '#worker/mcp/secrets/secret-providers/repo.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type CredentialKind } from './credential-ids.ts'

const now = '2026-10-13T00:00:00.000Z'
const ownerId = 'owner-org'
const otherOrgId = 'other-org'
const bucketId = 'owner-user-bucket'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	for (const id of [ownerId, otherOrgId]) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
			)
			.run(id, id, now, now)
	}
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key)
			VALUES (?, ?, 'user', '')`,
		)
		.run(bucketId, ownerId)
	sqlite
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
			VALUES (?, 'app', 'provider', 'client', 'https://auth.example.com/token', 'pkce')`,
		)
		.run(ownerId)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			VALUES ('vault-package', ?, 'vault', 'vault', '', 'source')`,
		)
		.run(ownerId)

	const insertCredential = (kind: CredentialKind, name: string): string => {
		switch (kind) {
			case 'secret':
				sqlite
					.prepare(
						`INSERT INTO secret_entries (bucket_id, name, encrypted_value)
						VALUES (?, ?, 'x')`,
					)
					.run(bucketId, name)
				return idOf(
					`SELECT id FROM secret_entries WHERE bucket_id = ? AND name = ?`,
					bucketId,
					name,
				)
			case 'integration':
				sqlite
					.prepare(
						`INSERT INTO user_integrations (user_id, name, app_slug)
						VALUES (?, ?, 'app')`,
					)
					.run(ownerId, name)
				return idOf(
					`SELECT id FROM user_integrations WHERE user_id = ? AND name = ?`,
					ownerId,
					name,
				)
			case 'mcp-server':
				sqlite
					.prepare(
						`INSERT INTO mcp_server_settings (id, user_id, name, url)
						VALUES (?, ?, ?, 'https://mcp.example.com')`,
					)
					.run(`mcp-${name}`, ownerId, name)
				return `mcp-${name}`
			case 'vault':
				sqlite
					.prepare(
						`INSERT INTO secret_provider_bindings
							(user_id, provider_id, package_id, door_secret_name)
						VALUES (?, ?, 'vault-package', 'doorKey')`,
					)
					.run(ownerId, name)
				return idOf(
					`SELECT id FROM secret_provider_bindings
					WHERE user_id = ? AND provider_id = ?`,
					ownerId,
					name,
				)
			default: {
				const exhaustive: never = kind
				throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
			}
		}
	}

	const idOf = (sql: string, ...params: Array<string>) =>
		String((sqlite.prepare(sql).get(...params) as { id: string }).id)

	const grantEverything = (credentialId: string) => {
		for (const subjectId of ['ann', 'bea']) {
			const grantId = `grant-${credentialId}-${subjectId}`
			sqlite
				.prepare(
					`INSERT INTO grants (id, org_id, resource_type, resource_id,
						subject_type, subject_id, preset, created_by_user_id,
						created_at, updated_at)
					VALUES (?, ?, 'credential', ?, 'user', ?, 'use', 'bea', ?, ?)`,
				)
				.run(grantId, ownerId, credentialId, subjectId, now, now)
			sqlite
				.prepare(
					`INSERT INTO grant_permissions (grant_id, permission)
					VALUES (?, 'secret.use')`,
				)
				.run(grantId)
		}
		sqlite
			.prepare(
				`INSERT INTO invites (id, org_id, kind, resource_type, resource_id,
					preset, invitee_username, token_hash, status, invited_by_user_id,
					expires_at, created_at)
				VALUES (?, ?, 'grant', 'credential', ?, 'use', 'cy', ?, 'pending',
					'bea', '2099-01-01T00:00:00.000Z', ?)`,
			)
			.run(`invite-${credentialId}`, ownerId, credentialId, credentialId, now)
		sqlite
			.prepare(
				`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
				VALUES (?, ?, ?, ?)`,
			)
			.run(credentialId, ownerId, otherOrgId, now)
	}

	const snapshot = (credentialId: string) => ({
		liveGrants: sqlite
			.prepare(
				`SELECT subject_id FROM grants
				WHERE resource_type = 'credential' AND resource_id = ?
					AND deleted_at IS NULL ORDER BY subject_id`,
			)
			.all(credentialId)
			.map((row) => row['subject_id']),
		pendingInvites: sqlite
			.prepare(
				`SELECT id FROM invites
				WHERE resource_type = 'credential' AND resource_id = ?
					AND status = 'pending'`,
			)
			.all(credentialId)
			.map((row) => row['id']),
		orgGrants: sqlite
			.prepare(
				`SELECT org_id FROM credential_org_grants WHERE credential_id = ?`,
			)
			.all(credentialId)
			.map((row) => row['org_id']),
	})

	const accessEpoch = () =>
		Number(
			(
				sqlite
					.prepare(`SELECT access_epoch FROM orgs WHERE id = ?`)
					.get(ownerId) as { access_epoch: number }
			).access_epoch,
		)

	return { db, insertCredential, grantEverything, snapshot, accessEpoch }
}

const deleteByKind: Record<
	CredentialKind,
	(db: D1Database, name: string, id: string) => Promise<unknown>
> = {
	secret: (db, name) =>
		deleteSecretEntry({ db, userId: ownerId, bucketId, name }),
	integration: (db, name) =>
		deleteIntegrationConnection({ db, userId: ownerId, name }),
	'mcp-server': (db, _name, id) =>
		deleteMcpServerSettingRow({ db, userId: ownerId, id }),
	vault: (db, name) =>
		deleteSecretProviderBinding(db, { userId: ownerId, providerId: name }),
}

test.each(Object.keys(deleteByKind) as Array<CredentialKind>)(
	'deleting a %s credential leaves no grants on it and keeps grants on others',
	async (kind) => {
		const { db, insertCredential, grantEverything, snapshot, accessEpoch } =
			setup()
		const doomed = insertCredential(kind, 'doomed')
		const kept = insertCredential(kind, 'kept')
		grantEverything(doomed)
		grantEverything(kept)
		const keptBefore = snapshot(kept)
		const epochBefore = accessEpoch()

		await deleteByKind[kind](db, 'doomed', doomed)

		expect(snapshot(doomed)).toEqual({
			liveGrants: [],
			pendingInvites: [],
			orgGrants: [],
		})
		expect(snapshot(kept)).toEqual(keptBefore)
		expect(keptBefore).toEqual({
			liveGrants: ['ann', 'bea'],
			pendingInvites: [`invite-${kept}`],
			orgGrants: [otherOrgId],
		})
		expect(accessEpoch()).toBe(epochBefore + 1)
	},
)

test('deleting a credential with no grants leaves the access epoch alone', async () => {
	const { db, insertCredential, accessEpoch } = setup()
	const doomed = insertCredential('secret', 'doomed')
	const epochBefore = accessEpoch()

	await deleteByKind.secret(db, 'doomed', doomed)

	expect(accessEpoch()).toBe(epochBefore)
})

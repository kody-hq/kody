import {
	type SecretProviderBindingRecord,
	type SecretProviderGrantRecord,
} from './types.ts'

import { credentialGrantCleanupStatements } from '#worker/credentials/credential-grant-cleanup.ts'
import { readCredentialFillPlacement } from '#worker/credentials/fill-placement.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
type BindingRow = {
	id: string
	user_id: string
	provider_id: string
	package_id: string
	door_secret_name: string
	config_json: string
	placement_json: string | null
	created_at: string
	updated_at: string
}

type GrantRow = {
	user_id: string
	provider_id: string
	canonical_ref: string
	package_id: string
	created_at: string
}

export function parseSecretProviderConfigJson(
	raw: string | null | undefined,
): Record<string, string> {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		const config: Record<string, string> = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string') config[key] = value
		}
		return config
	} catch {
		return {}
	}
}

function toBindingRecord(row: BindingRow): SecretProviderBindingRecord {
	return {
		credentialId: row.id,
		userId: row.user_id,
		providerId: row.provider_id,
		packageId: row.package_id,
		doorSecretName: row.door_secret_name,
		config: parseSecretProviderConfigJson(row.config_json),
		placement: readCredentialFillPlacement(row.placement_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function toGrantRecord(row: GrantRow): SecretProviderGrantRecord {
	return {
		userId: row.user_id,
		providerId: row.provider_id,
		canonicalRef: row.canonical_ref,
		packageId: row.package_id,
		createdAt: row.created_at,
	}
}

async function deleteSecretProviderGrantsForBinding(
	db: D1Database,
	input: { userId: string; providerId: string },
) {
	await db
		.prepare(
			`DELETE FROM secret_provider_grants
			WHERE user_id = ? AND provider_id = ?`,
		)
		.bind(input.userId, input.providerId)
		.run()
}

export async function upsertSecretProviderBinding(
	db: D1Database,
	input: {
		userId: string
		providerId: string
		packageId: string
		doorSecretName: string
		configJson: string
	},
) {
	const existing = await getSecretProviderBinding(db, {
		userId: input.userId,
		providerId: input.providerId,
	})
	if (existing && existing.packageId !== input.packageId) {
		await deleteSecretProviderGrantsForBinding(db, {
			userId: input.userId,
			providerId: input.providerId,
		})
	}
	await db
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json,
				source_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, json_object('vault', ?), CURRENT_TIMESTAMP,
				CURRENT_TIMESTAMP
			)
			ON CONFLICT(user_id, provider_id) DO UPDATE SET
				package_id = excluded.package_id,
				door_secret_name = excluded.door_secret_name,
				config_json = excluded.config_json,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.userId,
			input.providerId,
			input.packageId,
			input.doorSecretName,
			input.configJson,
			input.providerId,
		)
		.run()
}

export async function deleteSecretProviderBinding(
	db: D1Database,
	input: { userId: string; providerId: string },
) {
	await deleteSecretProviderGrantsForBinding(db, input)
	const liveRowSql = `FROM secret_provider_bindings
			WHERE user_id = ? AND provider_id = ?${andLiveDeletedAtSql()}`
	await db.batch([
		...credentialGrantCleanupStatements(db, {
			ownerId: input.userId,
			credentialIdSql: `SELECT id ${liveRowSql}`,
			credentialIdBindings: [input.userId, input.providerId],
		}),
		db.prepare(`DELETE ${liveRowSql}`).bind(input.userId, input.providerId),
	])
}

export async function getSecretProviderBinding(
	db: D1Database,
	input: { userId: string; providerId: string },
): Promise<SecretProviderBindingRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, provider_id, package_id, door_secret_name, config_json,
				placement_json, created_at, updated_at
			FROM secret_provider_bindings
			WHERE user_id = ? AND provider_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.providerId)
		.first<BindingRow>()
	return row ? toBindingRecord(row) : null
}

export async function listSecretProviderBindings(
	db: D1Database,
	input: { userId: string },
): Promise<Array<SecretProviderBindingRecord>> {
	const result = await db
		.prepare(
			`SELECT id, user_id, provider_id, package_id, door_secret_name, config_json,
				placement_json, created_at, updated_at
			FROM secret_provider_bindings
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY provider_id ASC`,
		)
		.bind(input.userId)
		.all<BindingRow>()
	return (result.results ?? []).map(toBindingRecord)
}

export async function insertSecretProviderGrant(
	db: D1Database,
	input: {
		userId: string
		providerId: string
		canonicalRef: string
		packageId: string
	},
) {
	await db
		.prepare(
			`INSERT INTO secret_provider_grants (
				user_id, provider_id, canonical_ref, package_id, created_at
			) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(user_id, provider_id, canonical_ref, package_id) DO NOTHING`,
		)
		.bind(input.userId, input.providerId, input.canonicalRef, input.packageId)
		.run()
}

export async function deleteSecretProviderGrant(
	db: D1Database,
	input: {
		userId: string
		providerId: string
		canonicalRef: string
		packageId: string
	},
) {
	await db
		.prepare(
			`DELETE FROM secret_provider_grants
			WHERE user_id = ? AND provider_id = ? AND canonical_ref = ? AND package_id = ?`,
		)
		.bind(input.userId, input.providerId, input.canonicalRef, input.packageId)
		.run()
}

export async function getSecretProviderGrant(
	db: D1Database,
	input: {
		userId: string
		providerId: string
		canonicalRef: string
		packageId: string
	},
): Promise<SecretProviderGrantRecord | null> {
	const row = await db
		.prepare(
			`SELECT user_id, provider_id, canonical_ref, package_id, created_at
			FROM secret_provider_grants
			WHERE user_id = ? AND provider_id = ? AND canonical_ref = ? AND package_id = ?`,
		)
		.bind(input.userId, input.providerId, input.canonicalRef, input.packageId)
		.first<GrantRow>()
	return row ? toGrantRecord(row) : null
}

export async function listSecretProviderGrantsForPackage(
	db: D1Database,
	input: { userId: string; packageId: string },
): Promise<Array<SecretProviderGrantRecord>> {
	const result = await db
		.prepare(
			`SELECT user_id, provider_id, canonical_ref, package_id, created_at
			FROM secret_provider_grants
			WHERE user_id = ? AND package_id = ?
			ORDER BY provider_id ASC, canonical_ref ASC`,
		)
		.bind(input.userId, input.packageId)
		.all<GrantRow>()
	return (result.results ?? []).map(toGrantRecord)
}

export async function listSecretProviderGrantsForUser(
	db: D1Database,
	input: { userId: string },
): Promise<Array<SecretProviderGrantRecord>> {
	const result = await db
		.prepare(
			`SELECT user_id, provider_id, canonical_ref, package_id, created_at
			FROM secret_provider_grants
			WHERE user_id = ?
			ORDER BY provider_id ASC, canonical_ref ASC, package_id ASC`,
		)
		.bind(input.userId)
		.all<GrantRow>()
	return (result.results ?? []).map(toGrantRecord)
}

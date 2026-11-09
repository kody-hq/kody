/**
 * Stable credential ids. Every org credential row carries an `id`: secret
 * entries, OAuth integrations, and vault bindings get theirs from the
 * database on insert (migration 0110), and an MCP server's row id is its
 * credential id. Grants on credentials are keyed by this id under the one
 * `credential` resource type, so renaming a credential keeps its grants and
 * a deleted then recreated name starts with none.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import type { CredentialPermissionFamily } from '@kody-internal/shared/org-permissions.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgResource } from '#worker/authorization/authorize.ts'

export const credentialKinds = [
	'secret',
	'integration',
	'mcp-server',
	'vault',
] as const

export type CredentialKind = (typeof credentialKinds)[number]

export type OrgCredential = {
	id: string
	kind: CredentialKind
	/** Secret, integration, or MCP server name; a vault binding's provider id. */
	name: string
	/** False when the row (or its secret bucket) is soft-deleted. */
	live: boolean
}

/** The permission family a credential's grants and checks use. */
export function credentialPermissionFamily(
	kind: CredentialKind,
): CredentialPermissionFamily {
	switch (kind) {
		case 'secret':
		case 'vault':
			return 'secret'
		case 'integration':
		case 'mcp-server':
			return 'integration'
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

export function credentialResource(
	orgId: OwnerId,
	credential: { id: string; name: string },
): OrgResource {
	return {
		type: 'credential',
		id: credential.id,
		orgId,
		label: credential.name,
	}
}

/**
 * The check target when the named credential does not exist. No grant can
 * name it, so only org-wide holders pass (and then see "not found"); anyone
 * else gets the same denial as for a credential they cannot use.
 */
export function missingCredentialResource(
	orgId: OwnerId,
	name: string,
): OrgResource {
	return { type: 'credential', id: '', orgId, label: name }
}

type CredentialRow = {
	id: string
	name: string
	live: number
}

const credentialQueries: ReadonlyArray<{
	kind: CredentialKind
	sql: (placeholders: string) => string
}> = [
	{
		kind: 'secret',
		sql: (placeholders) =>
			`SELECT e.id AS id, e.name AS name,
				(e.deleted_at IS NULL AND b.deleted_at IS NULL) AS live
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND e.id IN (${placeholders})`,
	},
	{
		kind: 'integration',
		sql: (placeholders) =>
			`SELECT id, name, (deleted_at IS NULL) AS live
			FROM user_integrations
			WHERE user_id = ? AND id IN (${placeholders})`,
	},
	{
		kind: 'mcp-server',
		sql: (placeholders) =>
			`SELECT id, name, (deleted_at IS NULL) AS live
			FROM mcp_server_settings
			WHERE user_id = ? AND id IN (${placeholders})`,
	},
	{
		kind: 'vault',
		sql: (placeholders) =>
			`SELECT id, provider_id AS name, (deleted_at IS NULL) AS live
			FROM secret_provider_bindings
			WHERE user_id = ? AND id IN (${placeholders})`,
	},
]

/**
 * Credentials of `orgId` by id, live or soft-deleted. Ids that name no
 * credential in the org are absent. Throws when one id names two rows.
 */
export async function listOrgCredentialsByIds(
	db: D1Database,
	orgId: string,
	ids: ReadonlyArray<string>,
): Promise<Map<string, OrgCredential>> {
	const credentials = new Map<string, OrgCredential>()
	const unique = [...new Set(ids.filter(Boolean))]
	for (const chunk of chunkArray(unique, maxD1BoundParameters - 1)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const results = await Promise.all(
			credentialQueries.map(async (query) => {
				const result = await db
					.prepare(query.sql(placeholders))
					.bind(orgId, ...chunk)
					.all<CredentialRow>()
				return { kind: query.kind, rows: result.results ?? [] }
			}),
		)
		for (const { kind, rows } of results) {
			for (const row of rows) {
				if (credentials.has(row.id)) {
					throw new Error(`Credential id ${row.id} names more than one row.`)
				}
				credentials.set(row.id, {
					id: row.id,
					kind,
					name: row.name,
					live: Boolean(row.live),
				})
			}
		}
	}
	return credentials
}

/**
 * By-name targets: `secret` and `integration` name a credential by its name,
 * as placeholders do. By-name grant targets resolve to the credential id
 * once, at grant time; an enablement paused on a credential that did not
 * exist yet resolves its name on each check. They are permanent, beside
 * grants by credential id (ADR 0068).
 */
export const legacyNamedCredentialTargets = [
	'secret',
	'integration',
] as const satisfies ReadonlyArray<CredentialPermissionFamily>

export type LegacyNamedCredentialTarget =
	(typeof legacyNamedCredentialTargets)[number]

export function isLegacyNamedCredentialTarget(
	value: unknown,
): value is LegacyNamedCredentialTarget {
	return (legacyNamedCredentialTargets as ReadonlyArray<unknown>).includes(
		value,
	)
}

/**
 * The credential ids a by-name target names: a user-scope secret, or every
 * integration (OAuth connection and MCP server) with that stored name. An
 * OAuth connection and an MCP server may share a name, so an integration
 * name can name two credentials. Empty when nothing live has that name.
 */
export async function findCredentialIdsByLegacyName(
	db: D1Database,
	orgId: string,
	target: { type: LegacyNamedCredentialTarget; name: string },
): Promise<Array<string>> {
	switch (target.type) {
		case 'secret': {
			const row = await db
				.prepare(
					`SELECT e.id AS id FROM secret_entries e
					JOIN secret_buckets b ON b.id = e.bucket_id
					WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
						AND e.name = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
				)
				.bind(orgId, target.name)
				.first<{ id: string }>()
			return row ? [row.id] : []
		}
		case 'integration': {
			const result = await db
				.prepare(
					`SELECT id FROM user_integrations
					WHERE user_id = ? AND name = ? AND deleted_at IS NULL
					UNION ALL
					SELECT id FROM mcp_server_settings
					WHERE user_id = ? AND name = ? AND deleted_at IS NULL`,
				)
				.bind(orgId, target.name, orgId, target.name)
				.all<{ id: string }>()
			return (result.results ?? []).map((row) => row.id)
		}
		default: {
			const exhaustive: never = target.type
			throw new Error(`Unhandled legacy grant target: ${String(exhaustive)}`)
		}
	}
}

export async function getOrgCredential(
	db: D1Database,
	orgId: string,
	id: string,
): Promise<OrgCredential | null> {
	const credentials = await listOrgCredentialsByIds(db, orgId, [id])
	return credentials.get(id) ?? null
}

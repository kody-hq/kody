/**
 * Personal credentials (credentials plan v4 section 3.2, ADR 0068).
 *
 * A personal credential is a secret, OAuth connection, or MCP server in its
 * owner's personal org. The owner grants it to another org one org at a
 * time, and it then works only in the owner's own runs there, while the
 * owner still has a live binding to that org. Owners and Automation of the
 * org never use someone else's personal credential: no grant, role, or
 * package stamp reaches it.
 *
 * Placeholders and scoped `credential()` clients both resolve the same set:
 * the org's credentials the actor can Use, plus the actor's own personal
 * credentials granted into the org (owner's runs only). The owner manages
 * grants with `credentialOrgGrant`, `credentialOrgRevoke`, and
 * `credentialOrgGrantList`.
 */
import {
	ownerIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit-outbox.ts'
import { runAppDbBatchWithOrgAudit } from '#worker/orgs/org-audit.ts'
import {
	isOrgActive,
	loadLiveOrgBindingForOrg,
	loadOrgBindingForOrg,
} from '#worker/orgs/repo.ts'
import {
	integrationConnectedSql,
	integrationUsableInOrgSql,
} from '#worker/integrations/connected.ts'
import { bumpUsableCredentialsGeneration } from './credential-read-generation.ts'
import {
	credentialPermissionFamily,
	getOrgCredential,
	listOrgCredentialsByIds,
	missingCredentialResource,
	type OrgCredential,
} from './credential-ids.ts'

export type PersonalCredential = OrgCredential & {
	ownerKind: 'user'
	ownerPersonId: PersonId
}

export const pinnedGrantRefusedMessage =
	"This OAuth connection was made through another org's OAuth app, so it is pinned to that org and cannot be granted to any other org. Connect your account through this org's app, or with your own app, instead."

/**
 * The org a personal OAuth connection is pinned to: the org that owns the
 * app it was made through, when that is not the connection's own org.
 */
export async function loadPinnedOrgId(
	db: D1Database,
	ownerOrgId: OwnerId,
	credentialId: string,
): Promise<OwnerId | null> {
	const row = await db
		.prepare(
			`SELECT app_owner_id FROM user_integrations
			WHERE user_id = ? AND id = ? AND app_slug IS NOT NULL
				AND app_owner_id IS NOT NULL AND app_owner_id <> user_id
				AND deleted_at IS NULL`,
		)
		.bind(ownerOrgId, credentialId)
		.first<{ app_owner_id: string }>()
	return row ? ownerIdFromStored(row.app_owner_id) : null
}

const notFoundMessage =
	'No personal credential with that id. Pass the credential_id of a secret, integration, or MCP server in your personal org.'

/**
 * Usable rows per kind, matching what scoped clients resolve
 * (`credential-candidates.ts`): an unexpired user-scope secret, a connected
 * OAuth connection, an enabled MCP server.
 */
const usableQueries: Record<
	Exclude<OrgCredential['kind'], 'vault'>,
	(placeholders: string) => {
		sql: string
		binds: (now: string, orgId: OwnerId) => Array<string>
	}
> = {
	secret: (placeholders) => ({
		sql: `SELECT e.id AS id FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND e.encrypted_value IS NOT NULL AND e.encrypted_value != ''
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)
				AND e.id IN (${placeholders})`,
		binds: (now) => [now, now],
	}),
	integration: (placeholders) => ({
		sql: `SELECT id FROM user_integrations
			WHERE user_id = ? AND deleted_at IS NULL AND ${integrationConnectedSql()}
				AND ${integrationUsableInOrgSql('?')}
				AND id IN (${placeholders})`,
		binds: (_now, orgId) => [orgId],
	}),
	'mcp-server': (placeholders) => ({
		sql: `SELECT id FROM mcp_server_settings
			WHERE user_id = ? AND deleted_at IS NULL AND enabled = 1
				AND id IN (${placeholders})`,
		binds: () => [],
	}),
}

/**
 * The owner's credentials among `ids` that can be personal credentials in
 * `orgId` now: live, in an active personal org, not a vault binding, and
 * usable the way scoped clients require (`usableQueries`). Package and
 * session secrets stay with their package or session. An OAuth connection
 * made through another org's app counts only for that org (pinned).
 */
async function loadPersonalCredentials(
	db: D1Database,
	ownerPersonId: PersonId,
	ids: ReadonlyArray<string>,
	now: Date,
	orgId: OwnerId,
): Promise<Map<string, OrgCredential>> {
	const ownerOrgId = await loadPersonalOrgIdForPerson(db, ownerPersonId)
	if (ids.length === 0 || !(await isOrgActive(db, ownerOrgId))) {
		return new Map()
	}
	const credentials = await listOrgCredentialsByIds(db, ownerOrgId, ids)
	const usableIds = new Set<string>()
	const nowIso = now.toISOString()
	for (const [kind, query] of Object.entries(usableQueries)) {
		const kindIds = [...credentials.values()]
			.filter((credential) => credential.live && credential.kind === kind)
			.map((credential) => credential.id)
		for (const chunk of chunkArray(kindIds, maxD1BoundParameters - 3)) {
			const { sql, binds } = query(chunk.map(() => '?').join(', '))
			const result = await db
				.prepare(sql)
				.bind(ownerOrgId, ...binds(nowIso, orgId), ...chunk)
				.all<{ id: string }>()
			for (const row of result.results ?? []) usableIds.add(row.id)
		}
	}
	return new Map([...credentials].filter(([id]) => usableIds.has(id)))
}

/**
 * Grants the owner's personal credential to `orgId`. The owner must have a
 * live binding to that org, and the credential must be usable as a personal
 * credential (`loadPersonalCredentials`). Vault bindings are org
 * configuration, not credentials a person carries, so they cannot be granted.
 */
export async function grantPersonalCredentialToOrg(input: {
	db: D1Database
	ownerPersonId: PersonId
	credentialId: string
	orgId: OwnerId
	now?: Date
	audit?: OrgAuditWriter
}): Promise<PersonalCredential & { created: boolean }> {
	const ownerOrgId = await loadPersonalOrgIdForPerson(
		input.db,
		input.ownerPersonId,
	)
	if (input.orgId === ownerOrgId) {
		throw new McpCallerError(
			'A personal credential already works in your personal org; grant it to another org.',
		)
	}
	const now = input.now ?? new Date()
	const pinnedOrgId = await loadPinnedOrgId(
		input.db,
		ownerOrgId,
		input.credentialId,
	)
	if (pinnedOrgId && pinnedOrgId !== input.orgId) {
		throw new McpCallerError(pinnedGrantRefusedMessage)
	}
	const credential = (
		await loadPersonalCredentials(
			input.db,
			input.ownerPersonId,
			[input.credentialId],
			now,
			input.orgId,
		)
	).get(input.credentialId)
	if (!credential) throw new McpCallerError(notFoundMessage)
	const binding = await loadLiveOrgBindingForOrg(
		input.db,
		input.ownerPersonId,
		input.orgId,
	)
	if (!binding) {
		throw new McpCallerError(
			'You can only grant a personal credential to an org you belong to.',
		)
	}
	const insert = input.db
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (credential_id, org_id) DO NOTHING`,
		)
		.bind(credential.id, input.ownerPersonId, input.orgId, now.toISOString())
	const created = input.audit
		? (
				await runAppDbBatchWithOrgAudit({
					appDb: input.db,
					audit: input.audit,
					statements: [insert],
					event: grantAuditEvent({
						action: 'credential.personal_org_granted',
						ownerOrgId,
						credential,
						orgId: input.orgId,
					}),
					onlyIfChanged: true,
				})
			).changed
		: ((await insert.run()).meta.changes ?? 0) > 0
	if (created) bumpUsableCredentialsGeneration(input.db)
	return {
		...credential,
		ownerKind: 'user',
		ownerPersonId: input.ownerPersonId,
		created,
	}
}

/** Grant changes are audited in the owner's personal org, by credential id. */
function grantAuditEvent(input: {
	action: 'credential.personal_org_granted' | 'credential.personal_org_revoked'
	ownerOrgId: OwnerId
	credential: Pick<OrgCredential, 'id' | 'kind'>
	orgId: OwnerId
}) {
	return {
		orgId: input.ownerOrgId,
		action: input.action,
		resourceType: 'credential',
		resourceId: input.credential.id,
		details: {
			credentialKind: input.credential.kind,
			grantedOrgId: input.orgId,
		},
	}
}

/** Removes one org grant of the owner's personal credential. */
export async function revokePersonalCredentialOrgGrant(input: {
	db: D1Database
	ownerPersonId: PersonId
	credentialId: string
	orgId: OwnerId
	audit?: OrgAuditWriter
}): Promise<boolean> {
	const remove = input.db
		.prepare(
			`DELETE FROM credential_org_grants
			WHERE credential_id = ? AND user_id = ? AND org_id = ?`,
		)
		.bind(input.credentialId, input.ownerPersonId, input.orgId)
	if (!input.audit) {
		const result = await remove.run()
		const changed = (result.meta.changes ?? 0) > 0
		if (changed) bumpUsableCredentialsGeneration(input.db)
		return changed
	}
	const ownerOrgId = await loadPersonalOrgIdForPerson(
		input.db,
		input.ownerPersonId,
	)
	const credential = await getOrgCredential(
		input.db,
		ownerOrgId,
		input.credentialId,
	)
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [remove],
		event: grantAuditEvent({
			action: 'credential.personal_org_revoked',
			ownerOrgId,
			credential: {
				id: input.credentialId,
				kind: credential?.kind ?? 'secret',
			},
			orgId: input.orgId,
		}),
		onlyIfChanged: true,
	})
	if (changed) bumpUsableCredentialsGeneration(input.db)
	return changed
}

export type PersonalCredentialOrgGrant = {
	credential: OrgCredential
	org: { id: OwnerId; slug: string; displayName: string | null }
	createdAt: string
	/**
	 * The grant works now: the credential is still usable as a personal
	 * credential and the owner still belongs to the org.
	 */
	active: boolean
}

/**
 * The owner's org grants, optionally for one credential. A grant whose
 * credential was deleted is left out; one that stopped working (expired
 * value, disconnected or disabled, lost membership) is listed with
 * `active: false`.
 */
export async function listPersonalCredentialOrgGrants(input: {
	db: D1Database
	ownerPersonId: PersonId
	credentialId?: string
	now?: Date
}): Promise<Array<PersonalCredentialOrgGrant>> {
	const ownerOrgId = await loadPersonalOrgIdForPerson(
		input.db,
		input.ownerPersonId,
	)
	const rows = await input.db
		.prepare(
			`SELECT g.credential_id, g.org_id, g.created_at, o.slug, o.display_name
			FROM credential_org_grants g
			JOIN orgs o ON o.id = g.org_id AND o.deleted_at IS NULL
			WHERE g.user_id = ?${input.credentialId ? ' AND g.credential_id = ?' : ''}
			ORDER BY o.slug, g.credential_id`,
		)
		.bind(
			input.ownerPersonId,
			...(input.credentialId ? [input.credentialId] : []),
		)
		.all<{
			credential_id: string
			org_id: string
			created_at: string
			slug: string
			display_name: string | null
		}>()
	const grants = rows.results ?? []
	const ids = [...new Set(grants.map((row) => row.credential_id))]
	const grantedOrgIds = [...new Set(grants.map((row) => row.org_id))]
	const [credentials, usableByOrg] = await Promise.all([
		listOrgCredentialsByIds(input.db, ownerOrgId, ids),
		Promise.all(
			grantedOrgIds.map(async (orgId) => {
				const orgIds = grants
					.filter((row) => row.org_id === orgId)
					.map((row) => row.credential_id)
				const usable = await loadPersonalCredentials(
					input.db,
					input.ownerPersonId,
					orgIds,
					input.now ?? new Date(),
					ownerIdFromStored(orgId),
				)
				return [orgId, usable] as const
			}),
		).then((entries) => new Map(entries)),
	])
	const bound = new Map<string, boolean>()
	for (const orgId of grantedOrgIds) {
		bound.set(
			orgId,
			Boolean(await loadOrgBindingForOrg(input.db, input.ownerPersonId, orgId)),
		)
	}
	return grants.flatMap((row) => {
		const credential = credentials.get(row.credential_id)
		if (!credential?.live) return []
		return [
			{
				credential,
				org: {
					id: ownerIdFromStored(row.org_id),
					slug: row.slug,
					displayName: row.display_name,
				},
				createdAt: row.created_at,
				active:
					(usableByOrg.get(row.org_id)?.has(row.credential_id) ?? false) &&
					(bound.get(row.org_id) ?? false),
			},
		]
	})
}

/** Org access ended: the person's personal credentials stop working there. */
export async function deletePersonalCredentialOrgGrantsForMember(input: {
	db: D1Database
	orgId: OwnerId
	personId: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_org_grants WHERE org_id = ? AND user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	return result.meta.changes ?? 0
}

/**
 * The actor's own personal credentials granted to `orgId` and still usable
 * (`loadPersonalCredentials`), while the actor still has a live binding to
 * it. Nobody else's personal credentials are ever candidates, whatever the
 * actor's role.
 */
export async function listPersonalCredentialCandidates(input: {
	db: D1Database
	actorPersonId: PersonId | null
	orgId: OwnerId
	now?: Date
}): Promise<Array<PersonalCredential>> {
	const actor = input.actorPersonId
	if (!actor) return []
	const actorPersonalOrgId = await loadPersonalOrgIdForPerson(input.db, actor)
	if (input.orgId === actorPersonalOrgId) return []
	if (!(await loadOrgBindingForOrg(input.db, actor, input.orgId))) return []
	const rows = await input.db
		.prepare(
			`SELECT credential_id FROM credential_org_grants
			WHERE org_id = ? AND user_id = ? ORDER BY credential_id`,
		)
		.bind(input.orgId, actor)
		.all<{ credential_id: string }>()
	const ids = (rows.results ?? []).map((row) => row.credential_id)
	const credentials = await loadPersonalCredentials(
		input.db,
		actor,
		ids,
		input.now ?? new Date(),
		input.orgId,
	)
	return ids.flatMap((id) => {
		const credential = credentials.get(id)
		if (!credential) return []
		return [{ ...credential, ownerKind: 'user' as const, ownerPersonId: actor }]
	})
}

/**
 * Use check for a personal credential in a run of `orgId`: it passes only
 * for the owner, through a live org grant. Throws the same denial whether
 * the credential is missing, someone else's, or not granted to the org.
 */
export async function authorizePersonalCredentialUse(input: {
	db: D1Database
	actorPersonId: PersonId | null
	orgId: OwnerId
	credentialId: string
	now?: Date
}): Promise<PersonalCredential> {
	const candidates = await listPersonalCredentialCandidates(input)
	const credential = candidates.find(
		(candidate) => candidate.id === input.credentialId,
	)
	if (credential) return credential
	// Only the actor's own personal org is read, so the denial says nothing
	// about anyone else's credentials.
	const own = input.actorPersonId
		? await getOrgCredential(
				input.db,
				await loadPersonalOrgIdForPerson(input.db, input.actorPersonId),
				input.credentialId,
			)
		: null
	const family = credentialPermissionFamily(own?.kind ?? 'secret')
	throw new AuthorizationError({
		code: 'missing_permission',
		permission: `${family}:use`,
		orgId: input.orgId,
		resource: missingCredentialResource(input.orgId, input.credentialId),
		message:
			'Not allowed to use this personal credential in this org. Only its owner can, after granting it to the org.',
	})
}

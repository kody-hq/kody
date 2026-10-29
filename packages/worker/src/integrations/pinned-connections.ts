/**
 * Personal OAuth connections made through another org's OAuth app (ADR 0068
 * amendment 2026-10-29). The connection lives in its owner's personal org
 * (`user_integrations.user_id`) and points at the org's app through
 * `app_owner_id`, which pins it to that org. The person owns it; the org's
 * admins can list and revoke it but never use it or read its tokens.
 *
 * Wiping one deletes the row (and its grants) first, then revokes it upstream
 * best effort, so a provider outage never leaves it usable.
 */
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	recordOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import { bumpUsableCredentialsGeneration } from '#worker/credentials/credential-read-generation.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	resolveIntegrationAccessToken,
	resolveIntegrationRefreshToken,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import { deleteIntegrationConnection, getOauthAppBySlug } from './repo.ts'
import {
	revokeOauthTokensUpstream,
	type UpstreamRevokeResult,
} from './upstream-revoke.ts'

export type PinnedConnection = {
	credentialId: string
	name: string
	/** The owner's personal org, where the connection and tokens live. */
	ownerOrgId: OwnerId
	ownerPersonId: PersonId | null
	ownerUsername: string | null
	ownerDisplayName: string | null
	/** The org that owns the app, and the only org it works in. */
	pinnedOrgId: OwnerId
	appSlug: string
	appLabel: string | null
	provider: string | null
	accountLabel: string | null
	connectedAt: string | null
	createdAt: string
}

export type PinnedConnectionWipeReason =
	| 'admin_revoked'
	| 'owner_disconnected'
	| 'member_left'
	| 'app_deleted'
	| 'org_deleted'

export const pinnedConnectionAuditActions = {
	revoked: 'credential.pinned_connection_revoked',
	wiped: 'credential.pinned_connection_wiped',
} as const

type PinnedRow = {
	id: string
	name: string
	user_id: string
	app_owner_id: string
	app_slug: string
	provider: string | null
	account_label: string | null
	connected_at: string | null
	created_at: string
	person_id: string | null
	username: string | null
	display_name: string | null
	app_label: string | null
}

/**
 * Pinned personal connections on `pinnedOrgId`'s apps, newest owner first by
 * name. Metadata only: no token, scope, or host is read.
 */
export async function listPinnedConnectionsForOrg(input: {
	db: D1Database
	pinnedOrgId: OwnerId
	appSlug?: string
	/** The owner's personal org. */
	ownerOrgId?: OwnerId
	credentialId?: string
}): Promise<Array<PinnedConnection>> {
	const filters: Array<string> = []
	const binds: Array<string> = [input.pinnedOrgId]
	if (input.appSlug) {
		filters.push('i.app_slug = ?')
		binds.push(input.appSlug)
	}
	if (input.ownerOrgId) {
		filters.push('i.user_id = ?')
		binds.push(input.ownerOrgId)
	}
	if (input.credentialId) {
		filters.push('i.id = ?')
		binds.push(input.credentialId)
	}
	const result = await input.db
		.prepare(
			`SELECT i.id, i.name, i.user_id, i.app_owner_id, i.app_slug, i.provider,
				i.account_label, i.connected_at, i.created_at,
				u.stable_user_id AS person_id, u.username, u.display_name,
				a.label AS app_label
			FROM user_integrations i
			LEFT JOIN users u ON u.deleted_at IS NULL AND (
				(u.personal_org_id IS NOT NULL AND TRIM(u.personal_org_id) != ''
					AND u.personal_org_id = i.user_id)
				OR ((u.personal_org_id IS NULL OR TRIM(u.personal_org_id) = '')
					AND u.stable_user_id = i.user_id)
			)
			LEFT JOIN user_oauth_apps a
				ON a.user_id = i.app_owner_id AND a.slug = i.app_slug
			WHERE i.app_owner_id = ? AND i.app_owner_id <> i.user_id
				AND i.app_slug IS NOT NULL AND i.deleted_at IS NULL
				AND i.id IS NOT NULL${filters.map((filter) => ` AND ${filter}`).join('')}
			ORDER BY COALESCE(u.username, i.user_id), i.app_slug, i.name`,
		)
		.bind(...binds)
		.all<PinnedRow>()
	return (result.results ?? []).map((row) => ({
		credentialId: row.id,
		name: row.name,
		ownerOrgId: ownerIdFromStored(row.user_id),
		ownerPersonId: row.person_id ? personIdFromStored(row.person_id) : null,
		ownerUsername: row.username,
		ownerDisplayName: row.display_name,
		pinnedOrgId: ownerIdFromStored(row.app_owner_id),
		appSlug: row.app_slug,
		appLabel: row.app_label,
		provider: row.provider,
		accountLabel: row.account_label,
		connectedAt: row.connected_at,
		createdAt: row.created_at,
	}))
}

export type PinnedConnectionWipeResult = {
	credentialId: string
	wiped: boolean
	upstream: UpstreamRevokeResult
}

type WipeEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

async function readTokensForRevoke(env: WipeEnv, connection: PinnedConnection) {
	try {
		const [access, refreshToken] = await Promise.all([
			resolveIntegrationAccessToken({
				env,
				userId: connection.ownerOrgId,
				name: connection.name,
			}),
			resolveIntegrationRefreshToken({
				env,
				userId: connection.ownerOrgId,
				name: connection.name,
			}),
		])
		return {
			accessToken: access?.accessToken ?? null,
			refreshToken,
		}
	} catch {
		return { accessToken: null, refreshToken: null }
	}
}

async function readAppForRevoke(env: WipeEnv, connection: PinnedConnection) {
	try {
		const app = await getOauthAppBySlug({
			db: env.APP_DB,
			userId: connection.pinnedOrgId,
			slug: connection.appSlug,
		})
		if (!app) return null
		const clientSecret = await resolveUserOauthAppClientSecret({
			env,
			userId: connection.pinnedOrgId,
			slug: connection.appSlug,
		})
		return { app, clientSecret }
	} catch {
		return null
	}
}

/**
 * Wipes one pinned connection: reads its tokens and the org app's client
 * credentials host-side, deletes the row and its grants, then revokes it
 * upstream. Audits the wipe in the owner's personal org and, for an admin
 * revoke, the revoke in the pinned org. Tokens never leave this function.
 */
export async function wipePinnedConnection(input: {
	env: WipeEnv
	connection: PinnedConnection
	reason: PinnedConnectionWipeReason
	audit: OrgAuditWriter | null
	fetchImpl?: typeof fetch
}): Promise<PinnedConnectionWipeResult> {
	const { connection } = input
	const [tokens, app] = await Promise.all([
		readTokensForRevoke(input.env, connection),
		readAppForRevoke(input.env, connection),
	])
	const wiped = await deleteIntegrationConnection({
		db: input.env.APP_DB,
		userId: connection.ownerOrgId,
		name: connection.name,
	})
	if (wiped) bumpUsableCredentialsGeneration(input.env.APP_DB)
	const upstream: UpstreamRevokeResult = app
		? await revokeOauthTokensUpstream({
				app: {
					provider: app.app.provider ?? connection.provider,
					tokenUrl: app.app.tokenUrl,
					clientId: app.app.clientId,
				},
				clientSecret: app.clientSecret,
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				fetchImpl: input.fetchImpl,
			})
		: { outcome: 'unsupported', status: null }
	if (!wiped) return { credentialId: connection.credentialId, wiped, upstream }
	const details = {
		credentialKind: 'integration',
		reason: input.reason,
		pinnedOrgId: connection.pinnedOrgId,
		appSlug: connection.appSlug,
		upstreamRevocation: upstream.outcome,
		upstreamStatus: upstream.status,
	}
	if (input.audit) {
		await recordOrgAuditEvent(input.audit, {
			orgId: connection.ownerOrgId,
			action: pinnedConnectionAuditActions.wiped,
			resourceType: 'credential',
			resourceId: connection.credentialId,
			details,
		})
		if (input.reason === 'admin_revoked') {
			await recordOrgAuditEvent(input.audit, {
				orgId: connection.pinnedOrgId,
				action: pinnedConnectionAuditActions.revoked,
				resourceType: 'credential',
				resourceId: connection.credentialId,
				targetUserId: connection.ownerPersonId,
				details,
			})
		}
	}
	if (upstream.outcome === 'failed') {
		console.warn('pinned-connection-upstream-revoke-failed', {
			credentialId: connection.credentialId,
			pinnedOrgId: connection.pinnedOrgId,
			appSlug: connection.appSlug,
			status: upstream.status,
		})
	}
	return { credentialId: connection.credentialId, wiped, upstream }
}

/** Wipes every match, one at a time; one failure does not stop the rest. */
export async function wipePinnedConnections(input: {
	env: WipeEnv
	connections: ReadonlyArray<PinnedConnection>
	reason: PinnedConnectionWipeReason
	audit: OrgAuditWriter | null
	fetchImpl?: typeof fetch
}): Promise<Array<PinnedConnectionWipeResult>> {
	const results: Array<PinnedConnectionWipeResult> = []
	for (const connection of input.connections) {
		results.push(await wipePinnedConnection({ ...input, connection }))
	}
	return results
}

/** Org access ended: wipe the person's connections pinned to `orgId`. */
export async function wipePinnedConnectionsForMember(input: {
	env: WipeEnv
	orgId: OwnerId
	personId: string
	audit: OrgAuditWriter | null
	reason?: PinnedConnectionWipeReason
	fetchImpl?: typeof fetch
}) {
	const ownerOrgId = await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		personIdFromStored(input.personId),
	)
	const connections = await listPinnedConnectionsForOrg({
		db: input.env.APP_DB,
		pinnedOrgId: input.orgId,
		ownerOrgId,
	})
	return wipePinnedConnections({
		env: input.env,
		connections,
		reason: input.reason ?? 'member_left',
		audit: input.audit,
		fetchImpl: input.fetchImpl,
	})
}

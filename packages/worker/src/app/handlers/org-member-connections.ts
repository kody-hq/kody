/**
 * Website reads and revokes for members' own connections made through an org
 * OAuth app (ADR 0068 amendment 2026-10-29). Admins with
 * `integration:manage_access` see every member's connection (metadata only)
 * and can revoke any; every member sees and can disconnect their own.
 */
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	AuthorizationError,
	authorizeOrgWide,
} from '#worker/authorization/authorize.ts'
import { resolvePinnedConnectTarget } from '#worker/integrations/pinned-connect.ts'
import {
	listPinnedConnectionsForOrg,
	type PinnedConnection,
	wipePinnedConnection,
} from '#worker/integrations/pinned-connections.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type OrgAppMemberConnectionsData } from '#universal/loader-data.ts'

type WebsiteUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

async function canManageMemberConnections(env: Env, user: WebsiteUser) {
	try {
		await authorizeOrgWide(
			{ env, request: user.request },
			'integration:manage_access',
		)
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}

function toView(connection: PinnedConnection, ownOrgId: string) {
	return {
		credentialId: connection.credentialId,
		memberUsername: connection.ownerUsername,
		memberDisplayName: connection.ownerDisplayName,
		accountLabel: connection.accountLabel,
		connectedAt: connection.connectedAt ?? connection.createdAt,
		yours: connection.ownerOrgId === ownOrgId,
	}
}

export async function loadOrgAppMemberConnections(input: {
	env: Env
	user: WebsiteUser
	appSlug: string
}): Promise<OrgAppMemberConnectionsData> {
	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	if (await isPersonalOrg(input.env.APP_DB, orgId)) {
		return {
			teamOrg: false,
			canConnectOwn: false,
			canManage: false,
			own: null,
			connections: [],
		}
	}
	const ownOrgId = personalOrgIdForPerson(input.user.mcpUser)
	const [target, canManage, all] = await Promise.all([
		resolvePinnedConnectTarget({
			env: input.env,
			request: input.user.request,
			mcpUser: input.user.mcpUser,
			appSlug: input.appSlug,
		}),
		canManageMemberConnections(input.env, input.user),
		listPinnedConnectionsForOrg({
			db: input.env.APP_DB,
			pinnedOrgId: orgId,
			appSlug: input.appSlug,
		}),
	])
	const own = all.find((connection) => connection.ownerOrgId === ownOrgId)
	return {
		teamOrg: true,
		canConnectOwn: target.ok,
		canManage,
		own: own ? toView(own, ownOrgId) : null,
		connections: canManage
			? all.map((connection) => toView(connection, ownOrgId))
			: [],
	}
}

export async function revokeOrgAppMemberConnection(input: {
	env: Env
	user: WebsiteUser
	credentialId: string
}) {
	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const [connection] = await listPinnedConnectionsForOrg({
		db: input.env.APP_DB,
		pinnedOrgId: orgId,
		credentialId: input.credentialId,
	})
	if (!connection) {
		return operationResult({ ok: false, error: 'Connection not found.' }, 404)
	}
	const yours =
		connection.ownerOrgId === personalOrgIdForPerson(input.user.mcpUser)
	if (!yours && !(await canManageMemberConnections(input.env, input.user))) {
		return operationResult(
			{
				ok: false,
				error:
					"Revoking a member's connection needs the integration:manage_access permission in this org.",
			},
			403,
		)
	}
	const result = await wipePinnedConnection({
		env: input.env,
		connection,
		reason: yours ? 'owner_disconnected' : 'admin_revoked',
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({
		ok: true,
		revoked: result.wiped,
		upstream: result.upstream.outcome,
	})
}

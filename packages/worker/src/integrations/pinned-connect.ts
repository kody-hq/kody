/**
 * "Connect your own account" through an org's OAuth app (ADR 0068 amendment
 * 2026-10-29). The connection and its tokens live in the member's personal
 * org; `app_owner_id` points at the org's app, which pins it to that org.
 * The org app's client id, token URL, and client secret are read host-side
 * from the app row, never from the request, so a member cannot point the
 * org's secret at another token URL, and never sees it.
 */
import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { getOrgById, loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	orgAuditWriterFromRequest,
	recordOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { grantPersonalCredentialToOrg } from '#worker/credentials/personal-credentials.ts'
import { bumpUsableCredentialsGeneration } from '#worker/credentials/credential-read-generation.ts'
import { normalizeAllowedHosts } from '#worker/secrets/allowed-hosts.ts'
import {
	persistIntegrationTokens,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import { inferIntegrationRefreshPolicy } from './refresh-policy.ts'
import {
	getJoinedIntegrationByName,
	getOauthAppBySlug,
	upsertIntegrationConnection,
} from './repo.ts'
import { type UserOauthApp } from './types.ts'

export type PinnedConnectTarget = {
	orgId: OwnerId
	orgSlug: string
	personId: PersonId
	personalOrgId: OwnerId
	app: UserOauthApp
	/** Connection name in the member's personal org. */
	connectionName: string
}

type Failure = { ok: false; error: string; status: number }

/** Name of the member's connection on `appSlug` in `orgSlug`. */
export function pinnedConnectionName(appSlug: string, orgSlug: string) {
	return canonicalIntegrationName(`${appSlug}-${orgSlug}`) ?? appSlug
}

/**
 * Checks the caller may connect their own account through the scoped org's
 * app: a team org (not their personal org), a live binding, and
 * `integration:use` there. Returns the org app without its secret.
 */
export async function resolvePinnedConnectTarget(input: {
	env: Env
	request: RequestContext
	mcpUser: McpUserContext
	appSlug: string
}): Promise<({ ok: true } & PinnedConnectTarget) | Failure> {
	const orgId = ownerIdFromCaller({
		request: input.request,
		user: input.mcpUser,
	})
	const personId = input.mcpUser.userId
	const personalOrgId = personalOrgIdForPerson(input.mcpUser)
	if (
		orgId === personalOrgId ||
		(await isPersonalOrg(input.env.APP_DB, orgId))
	) {
		return {
			ok: false,
			error:
				'Connecting your own account through an org app works in a team org. In your personal org, connect with your own app instead.',
			status: 400,
		}
	}
	const binding = await loadOrgBindingForOrg(input.env.APP_DB, personId, orgId)
	if (!binding) {
		return {
			ok: false,
			error:
				'You can only connect through the OAuth apps of an org you belong to.',
			status: 403,
		}
	}
	// Members and Owners may connect their own account: the connection is
	// theirs, usable only in their own runs here. Billing and outside
	// collaborators may not (ADR 0068 amendment 2026-10-29).
	if (binding.role !== 'owner' && binding.role !== 'member') {
		return {
			ok: false,
			error:
				'Connecting your own account through an org app needs the Member or Owner role in that org.',
			status: 403,
		}
	}
	const [app, org] = await Promise.all([
		getOauthAppBySlug({
			db: input.env.APP_DB,
			userId: orgId,
			slug: input.appSlug,
		}),
		getOrgById(input.env.APP_DB, orgId),
	])
	if (!app || !org) {
		return {
			ok: false,
			error: 'That org OAuth app was not found.',
			status: 404,
		}
	}
	if (app.flow === 'device') {
		return {
			ok: false,
			error:
				'Connecting your own account needs an app that uses the browser sign-in flow.',
			status: 400,
		}
	}
	return {
		ok: true,
		orgId,
		orgSlug: org.slug,
		personId,
		personalOrgId,
		app,
		connectionName: pinnedConnectionName(app.slug, org.slug),
	}
}

/** The org app's client secret, host-side only. Null for public clients. */
export async function resolvePinnedConnectClientSecret(input: {
	env: Env
	target: PinnedConnectTarget
}): Promise<string | null> {
	if (input.target.app.flow !== 'confidential') return null
	return resolveUserOauthAppClientSecret({
		env: input.env,
		userId: input.target.orgId,
		slug: input.target.app.slug,
	})
}

function readTokenField(payload: Record<string, unknown>, field: string) {
	const value = payload[field]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Saves the member's connection in their personal org, pinned to the org's
 * app, persists its tokens there, and grants it to that org only.
 */
export async function savePinnedConnection(input: {
	env: Env
	request: RequestContext
	target: PinnedConnectTarget
	scopes: Array<string>
	allowedHosts: Array<string>
	tokenRecord: Record<string, unknown>
}): Promise<
	| {
			ok: true
			integrationName: string
			credentialId: string
			refreshTokenSaved: boolean
			allowedHosts: Array<string>
	  }
	| Failure
> {
	const { target } = input
	const accessToken = readTokenField(input.tokenRecord, 'access_token')
	const refreshToken = readTokenField(input.tokenRecord, 'refresh_token')
	if (!accessToken) {
		return {
			ok: false,
			error: 'Token payload did not include an access_token.',
			status: 400,
		}
	}
	const db = input.env.APP_DB
	const name = target.connectionName
	const existing = await getJoinedIntegrationByName({
		db,
		userId: target.personalOrgId,
		name,
	})
	if (
		existing &&
		!(
			existing.lane === 'user' &&
			existing.app.userId === target.orgId &&
			existing.app.slug === target.app.slug
		)
	) {
		return {
			ok: false,
			error: `You already have a connection named "${name}" in your personal org. Rename or remove it, then connect again.`,
			status: 409,
		}
	}
	const allowedHosts = normalizeAllowedHosts([
		...input.allowedHosts,
		...[target.app.tokenUrl, target.app.apiBaseUrl]
			.map((url) => (url ? safeParseHost(url) : null))
			.filter((host): host is string => Boolean(host)),
	])
	const now = new Date().toISOString()
	await upsertIntegrationConnection({
		db,
		appOwnerId: target.orgId,
		row: {
			user_id: target.personalOrgId,
			name,
			app_slug: target.app.slug,
			platform_app_slug: null,
			account_label: existing?.connection.accountLabel ?? null,
			description: existing?.connection.description ?? '',
			scopes_json: JSON.stringify(input.scopes),
			required_hosts_json: JSON.stringify(allowedHosts),
			connected_at: existing?.connection.connectedAt ?? null,
			token_refreshed_at: existing?.connection.tokenRefreshedAt ?? null,
			created_at: existing?.connection.createdAt ?? now,
			updated_at: now,
		},
	})
	const audit = orgAuditWriterFromRequest(input.env, input.request)
	await persistIntegrationTokens({
		env: input.env,
		userId: target.personalOrgId,
		name,
		accessToken,
		refreshToken,
		refreshPolicy: inferIntegrationRefreshPolicy(input.tokenRecord),
		audit,
	})
	const saved = await getJoinedIntegrationByName({
		db,
		userId: target.personalOrgId,
		name,
	})
	if (!saved) throw new Error('Failed to save the OAuth connection.')
	const credentialId = saved.connection.credentialId
	if (!existing) {
		await recordOrgAuditEvent(audit, {
			orgId: target.personalOrgId,
			action: 'credential.created',
			resourceType: 'credential',
			resourceId: credentialId,
			details: {
				credentialKind: 'integration',
				name,
				pinnedOrgId: target.orgId,
				appSlug: target.app.slug,
			},
		})
	}
	await grantPersonalCredentialToOrg({
		db,
		ownerPersonId: target.personId,
		credentialId,
		orgId: target.orgId,
		audit,
	})
	bumpUsableCredentialsGeneration(db)
	return {
		ok: true,
		integrationName: name,
		credentialId,
		refreshTokenSaved: Boolean(refreshToken),
		allowedHosts,
	}
}

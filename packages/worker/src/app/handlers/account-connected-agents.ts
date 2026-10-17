import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { deleteMcpEventSubscriptionsForOauthClient } from '#mcp/events/subscriptions-repo.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
} from '#worker/connected-mcp-agents.ts'
import {
	createAccountConnectionProfile,
	updateAccountConnectionProfile,
	deleteAccountConnectionProfile,
	loadConnectionProfilesForAccount,
} from '#worker/connection-profiles/account.ts'
import {
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
} from '#worker/oauth-grants.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { buildMcpServerUrl } from '#worker/onboarding-prompts.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'

type ConnectedAgentsUser = {
	mcpUser: { userId: PersonId; personalOrgId?: OwnerId | null }
	emailVerified: boolean
	request: RequestContext
}

/**
 * Inbound agents are OAuth grants held by the signed-in person. The page org
 * (`request.org.id`) picks which of them to show: the ones approved for that
 * org. Connection profiles and the second-agent gift stay on the signup org.
 */
function connectedAgentsScope(user: ConnectedAgentsUser) {
	// Grants are person-keyed (legacy OwnerId brand of the person id).
	const personId = personalOrgId(user.mcpUser.userId)
	const personalOrgOwnerId = personalOrgIdForPerson(user.mcpUser)
	const orgId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	return {
		personId,
		orgId,
		personalOrgOwnerId,
		personalOrg: orgId === personalOrgOwnerId,
	}
}

export async function loadAccountConnectedAgentsData(input: {
	env: Env
	requestUrl: string | URL
	user: ConnectedAgentsUser
}): Promise<AccountConnectedAgentsLoaderData> {
	const { personId, orgId, personalOrg } = connectedAgentsScope(input.user)
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	const state = await loadInboundMcpConnectionState(helpers, personId, {
		env: input.env,
		orgId,
	})

	return {
		ok: true,
		agents: state.agents,
		mcpServerUrl: input.user.emailVerified
			? buildMcpServerUrl({ env: input.env, requestUrl: input.requestUrl })
			: '',
		...(personalOrg
			? await loadConnectionProfilesForAccount({
					env: input.env,
					requestUrl: input.requestUrl,
					userId: personId,
					emailVerified: input.user.emailVerified,
				})
			: {
					connectionProfilesEnabled: false,
					connectionProfiles: [],
					connectionProfilePackageOptions: [],
				}),
	}
}

type AgentMutationContext = {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
async function changeAccountConnectionProfile<T>(
	{ env, user }: AgentMutationContext,
	write: (context: {
		env: Env
		userId: string
	}) => Promise<
		{ ok: true; result: T } | { ok: false; error: string; status: number }
	>,
) {
	if (!connectedAgentsScope(user).personalOrg) {
		return operationResult(
			{
				ok: false,
				error:
					'Connection profiles are only available in your personal organization.',
			},
			404,
		)
	}
	const mutation = await write({
		env,
		userId: personalOrgId(user.mcpUser.userId),
	})
	if (!mutation.ok) {
		return operationResult(
			{ ok: false, error: mutation.error },
			mutation.status,
		)
	}
	return operationResult(mutation)
}
export function createConnectedAgentProfile(
	input: AgentMutationContext & { name: string; grants: unknown },
) {
	return changeAccountConnectionProfile(input, (context) =>
		createAccountConnectionProfile({
			...context,
			name: input.name,
			grants: input.grants,
		}),
	)
}
export function updateConnectedAgentProfile(
	input: AgentMutationContext & {
		profileId: string
		name?: string
		grants?: unknown
	},
) {
	return changeAccountConnectionProfile(input, (context) =>
		updateAccountConnectionProfile({
			...context,
			profileId: input.profileId,
			name: input.name,
			grants: input.grants,
		}),
	)
}
export function deleteConnectedAgentProfile(
	input: AgentMutationContext & { profileId: string },
) {
	return changeAccountConnectionProfile(input, (context) =>
		deleteAccountConnectionProfile({ ...context, profileId: input.profileId }),
	)
}
export async function revokeAccountConnectedAgent({
	request,
	env,
	user,
	clientId,
}: AgentMutationContext & { clientId: string }) {
	const helpers = await resolveOAuthHelpers<OAuthGrantHelpers>(env)
	if (!helpers) {
		return operationResult(
			{ ok: false, error: 'Connected agent listing is unavailable.' },
			503,
		)
	}

	const { personId, orgId } = connectedAgentsScope(user)
	const revoked = await revokeConnectedMcpAgent({
		helpers,
		userId: personId,
		clientId: clientId,
		orgId,
		env,
	})
	if ('error' in revoked) {
		// Retry cleanup when grants are already gone but subscription
		// rows may have survived a prior partial revoke.
		if (!revoked.clientRemains) {
			await deleteMcpEventSubscriptionsForOauthClient({
				db: env.APP_DB,
				oauthClientId: clientId,
				userId: personId,
			})
		}
		return operationResult(
			{ ok: false, error: 'Connected agent not found.' },
			404,
		)
	}
	if (!revoked.clientRemains) {
		await deleteMcpEventSubscriptionsForOauthClient({
			db: env.APP_DB,
			oauthClientId: clientId,
			userId: personId,
		})
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'mcp_inbound_grant_revoke',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		clientId: clientId,
	})
	return operationResult({ ok: true as const })
}

import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegration } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertScopesAllowedForPlatformApp,
	getIntegration,
	getJoinedIntegration,
	upsertIntegration,
	type IntegrationConfig,
} from '#worker/integrations/service.ts'
import { updatePlatformIntegrationRequestedScopes } from '#worker/integrations/repo.ts'
import {
	integrationConfigSchema,
	integrationSaveSchema,
	mergeIntegrationConfig,
	normalizeIntegrationConfig,
} from './integration-shared.ts'

const inputSchema = integrationSaveSchema

const outputSchema = z.object({
	integration: integrationConfigSchema,
})

export const integrationSaveCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationSave',
		contextRuns: 'deny',
		orgPermission: ['integration:write', 'integration:create'],
		description:
			"Create or update an OAuth integration connection for the signed-in user. Names are normalized to a canonical lowercase-kebab provider key. Partial updates merge into the existing connection; matching client credentials reuse a shared OAuth app across connections. Do not persist access or refresh tokens here or with secretSet — `/connect/oauth` and `integrationTokenRefresh` write those on the connection. authorization.scopes is reconnect metadata: the list the next /connect/oauth visit requests, not the current access token. After widening scopes, tell the user the token is unchanged until they reconnect, then ask whether to reconnect each affected account at /connect/oauth?provider=<connection-name>. Scopes are per connection; sibling accounts that share an OAuth app keep their own lists. This capability cannot change usageMode or add requiredHosts / retarget tokenUrl to an unapproved host. Platform (built-in) connections accept only authorization.scopes here (pass authorization with the authorizeUrl from integrationGet and the full new scope list, adding or removing scopes). Every scope must be on the built-in app's supported list, and the list cannot be empty. This changes only that one connection: the built-in defaults and sibling connections keep their own scopes, and the connection stays built-in. The current token keeps its old grant until the user reconnects at /connect/oauth?provider=<name>, where the provider asks for consent. After reconnecting, integrationGet returns grantedScopes (what the provider actually granted, with missing and extra versus the request); report any mismatch instead of claiming the scopes changed.",
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'save',
			'update',
			'upsert',
			'connection',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const existing = await getIntegration({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				name: args.name,
			})
			if (existing) {
				await authorizeIntegration(ctx, 'integration:write', existing.name)
			} else {
				await authorize(
					{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
					'integration:create',
				)
			}
			// A partial merge onto a platform (built-in) connection would
			// silently convert it to a user-lane app and break host-side
			// refresh; only its requested scopes change here.
			if (existing?.platform === true) {
				return {
					integration: await savePlatformConnectionScopes({
						ctx,
						existing,
						args,
					}),
				}
			}
			const config = existing
				? mergeIntegrationConfig(existing, args)
				: createNewIntegrationConfig(args)
			if (existing) {
				assertIntegrationSaveKeepsApprovedHosts({
					name: existing.name,
					current: existing,
					next: config,
				})
			}
			const integration = await upsertIntegration({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				config,
				...(args.accountLabel !== undefined
					? { accountLabel: args.accountLabel }
					: {}),
				...(args.logoBase64 !== undefined
					? { logoBase64: args.logoBase64 }
					: {}),
				waitUntil: ctx.waitUntil,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			return { integration }
		},
	},
)

async function savePlatformConnectionScopes(input: {
	ctx: CapabilityContext
	existing: IntegrationConfig
	args: z.infer<typeof inputSchema>
}): Promise<IntegrationConfig> {
	const { existing, args, ctx } = input
	const reconnectHref = `/connect/oauth?provider=${encodeURIComponent(existing.name)}`
	const { name: _name, authorization, ...rest } = args
	const otherFields = Object.entries(rest)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key)
	const changedAuthorizationFields = authorization
		? (
				['authorizeUrl', 'scopeSeparator', 'extraAuthorizeParams'] as const
			).filter(
				(key) =>
					authorization[key] !== undefined &&
					JSON.stringify(authorization[key]) !==
						JSON.stringify(existing.authorization?.[key]),
			)
		: []
	if (
		!authorization ||
		otherFields.length > 0 ||
		changedAuthorizationFields.length > 0
	) {
		const blocked = [
			...otherFields,
			...changedAuthorizationFields.map((key) => `authorization.${key}`),
			...(authorization ? [] : ['authorization (required)']),
		]
		throw new McpCallerError(
			`Integration "${existing.name}" is a platform (built-in) connection. integrationSave only changes its authorization.scopes; it cannot change ${blocked.join(', ')}. Pass authorization with the current authorizeUrl and the full scope list.`,
		)
	}
	const ownerId = ownerIdFromCaller(ctx.callerContext)
	const joined = await getJoinedIntegration({
		env: ctx.env,
		userId: ownerId,
		name: existing.name,
	})
	if (joined?.lane !== 'platform') {
		throw new McpCallerError(
			`Integration "${existing.name}" is no longer a platform connection. Call integrationGet and try again.`,
		)
	}
	let scopes: Array<string>
	try {
		scopes = assertScopesAllowedForPlatformApp(joined.app, authorization.scopes)
	} catch (error) {
		throw new McpCallerError(
			`${error instanceof Error ? error.message : 'Scopes not allowed.'} Supported scopes: ${joined.app.allowedScopes.join(', ') || 'none'}.`,
		)
	}
	if (scopes.length === 0) {
		throw new McpCallerError(
			`Integration "${existing.name}" needs at least one scope. Some providers reuse the previous grant when no scope is requested, so an empty list would not narrow the token.`,
		)
	}
	await updatePlatformIntegrationRequestedScopes({
		db: ctx.env.APP_DB,
		userId: ownerId,
		name: joined.connection.name,
		scopes,
	})
	const saved = await getIntegration({
		env: ctx.env,
		userId: ownerId,
		name: joined.connection.name,
	})
	if (!saved) {
		throw new Error(
			`Failed to update scopes on platform integration "${existing.name}". Reconnect at ${reconnectHref}.`,
		)
	}
	return saved
}

function createNewIntegrationConfig(
	args: z.infer<typeof inputSchema>,
): IntegrationConfig {
	const parsed = integrationConfigSchema.safeParse({
		name: args.name,
		tokenUrl: args.tokenUrl,
		apiBaseUrl: args.apiBaseUrl ?? null,
		flow: args.flow,
		...(args.usePkce !== undefined ? { usePkce: args.usePkce } : {}),
		clientId: args.clientId,
		requiredHosts: args.requiredHosts,
		...(args.tokenExchangeStyle !== undefined
			? { tokenExchangeStyle: args.tokenExchangeStyle }
			: {}),
		...(args.authorization !== undefined
			? { authorization: args.authorization }
			: {}),
	})
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => {
				const field = issue.path.join('.') || 'input'
				return `${field}: ${issue.message}`
			})
			.join(', ')
		// Create-time field gaps are caller-fixable (agents omit required
		// secrets names); keep them off Sentry via McpCallerError.
		throw new McpCallerError(
			`Cannot create integration "${args.name}": missing or invalid required fields — ${details}`,
		)
	}
	return normalizeIntegrationConfig(parsed.data)
}

function assertIntegrationSaveKeepsApprovedHosts(input: {
	name: string
	current: IntegrationConfig
	next: IntegrationConfig
}) {
	const currentTokenHost = safeParseHost(input.current.tokenUrl)
	const approved = new Set([
		...(input.current.requiredHosts ?? []),
		...(currentTokenHost ? [currentTokenHost] : []),
	])
	const addedHosts = (input.next.requiredHosts ?? []).filter(
		(host) => !approved.has(host),
	)
	if (addedHosts.length > 0) {
		throw new McpCallerError(
			`Cannot add required hosts (${addedHosts.join(', ')}) on "${input.name}" via integrationSave. Reconnect at /connect/oauth?provider=${encodeURIComponent(input.name)} so the user can approve new destinations.`,
		)
	}
	if (input.next.tokenUrl === input.current.tokenUrl) return
	const tokenHost = safeParseHost(input.next.tokenUrl)
	if (tokenHost && !approved.has(tokenHost)) {
		throw new McpCallerError(
			`Cannot point tokenUrl at host "${tokenHost}" on "${input.name}" via integrationSave. Reconnect at /connect/oauth?provider=${encodeURIComponent(input.name)} to approve that token endpoint.`,
		)
	}
}

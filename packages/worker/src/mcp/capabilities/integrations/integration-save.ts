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
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	getIntegration,
	upsertIntegration,
	type IntegrationConfig,
} from '#worker/integrations/service.ts'
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
		orgPermission: 'integration:write',
		description:
			'Create or update an OAuth integration connection for the signed-in user. Names are normalized to a canonical lowercase-kebab provider key. Partial updates merge into the existing connection; matching client credentials reuse a shared OAuth app across connections. Do not persist access or refresh tokens here or with secretSet — `/connect/oauth` and `integrationTokenRefresh` write those on the connection. authorization.scopes is reconnect metadata: the list the next /connect/oauth visit requests, not the current access token. After widening scopes, tell the user the token is unchanged until they reconnect, then ask whether to reconnect each affected account at /connect/oauth?provider=<connection-name>. Scopes are per connection; sibling accounts that share an OAuth app keep their own lists. This capability cannot change usageMode or add requiredHosts / retarget tokenUrl to an unapproved host. Platform (built-in) connections cannot be updated here — reconnect at /connect/oauth?provider=<name> to change scopes, or integrationDelete first to replace with a bring-your-own app.',
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
			// refresh; keep platform connections managed by the connect flow.
			if (existing?.platform === true) {
				throw new McpCallerError(
					`Integration "${args.name}" is a platform (built-in) connection managed at /connect/oauth?provider=${encodeURIComponent(existing.name)}. Reconnect there to change scopes, or integrationDelete it first to replace it with your own OAuth app.`,
				)
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

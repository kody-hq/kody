import { retiredOrgPermissionNames } from '@kody-internal/shared/org-permissions.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	cliCredentialBootstrapPolicy,
	mintCliCredentialBootstrap,
} from '#worker/api-tokens/cli-credential-bootstrap.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	apiTokenScopeDescriptions,
	apiTokenScopes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import {
	apiTokenIdleTtlDescription,
	apiTokenLifetimeAliasNames,
	apiTokenPolicy,
} from '#worker/api-tokens/service.ts'
import { requireMcpUser } from './require-user.ts'

const scopeSchema = z.enum(
	apiTokenScopes as [ApiTokenScope, ...Array<ApiTokenScope>],
)

/** Older clients may still request retired scopes; minting drops them. */
const requestedScopeSchema = z.union([
	scopeSchema,
	z.enum(retiredOrgPermissionNames),
])

const scopeListDescription = Object.entries(apiTokenScopeDescriptions)
	.map(([scope, description]) => `\`${scope}\`: ${description}`)
	.join('\n')

const lifetimeAliasSchema = z.enum(
	apiTokenLifetimeAliasNames as [string, ...Array<string>],
)

const inputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(apiTokenPolicy.maxNameLength)
			.optional()
			.describe(
				`Label for the eventual API token (default \`${cliCredentialBootstrapPolicy.defaultName}\`).`,
			),
		scopes: z
			.array(requestedScopeSchema)
			.min(1)
			.optional()
			.describe(
				`Org-permission scopes for the eventual \`kody_at_\`. Omit for the same scopes \`kody login\` gets: every org permission, capped by your org role on each request and by a parent API token's own scopes. Pass a list only when you want a narrower token; it replaces the default. There is no write-implies-read hierarchy.\n${scopeListDescription}`,
			),
		lifetime: lifetimeAliasSchema
			.optional()
			.describe(
				'Optional. Omit for the `kody login` lifetime (`long` = 14d idle / 3mo max, clamped to a parent API token). `short` = 1h idle / 24h max. Or set both idle_ttl_seconds and max_lifetime_seconds.',
			),
		idle_ttl_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxIdleTtlSeconds)
			.optional()
			.describe(
				'Seconds without use before the eventual token expires. Set together with max_lifetime_seconds instead of lifetime.',
			),
		max_lifetime_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxMaxLifetimeSeconds)
			.optional()
			.describe(
				'Absolute lifetime cap for the eventual token in seconds. Set together with idle_ttl_seconds instead of lifetime.',
			),
		redeem_ttl_seconds: z
			.number()
			.int()
			.min(cliCredentialBootstrapPolicy.minRedeemTtlSeconds)
			.max(cliCredentialBootstrapPolicy.maxRedeemTtlSeconds)
			.optional()
			.describe(
				`How long the one-shot bootstrap code stays redeemable (default ${cliCredentialBootstrapPolicy.defaultRedeemTtlSeconds}).`,
			),
	})
	.strict()

const outputSchema = z.object({
	bootstrap_code: z
		.string()
		.describe(
			'One-shot code for the CLI (`kody_bc_…`). Not an API token. Run the returned `cli_command` — do not paste a `kody_at_` into chat.',
		),
	expires_at: z.string().describe('Absolute redeem deadline (ISO-8601).'),
	cli_command: z
		.string()
		.describe(
			'Ready-to-run CLI command that redeems the code and saves it as the CLI credential, the same slot `kody login` uses, without a second interactive OAuth. Includes lifetime flags for older CLIs.',
		),
	name: z.string(),
	scopes: z.array(scopeSchema),
	idle_ttl_seconds: z.number().int(),
	max_lifetime_seconds: z.number().int(),
})

/**
 * Explicit MCP/API-session → CLI credential handoff (ADR 0056). Returns a
 * one-shot bootstrap code, never a `kody_at_`. Callable from the MCP `api`
 * tool and Open API `POST /v1/tokens/bootstrap` only; `execute` code (hosted
 * or `--local`) is refused so a module cannot mint itself a credential.
 */
export const cliCredentialBootstrapExecuteRefusal =
	'cliCredentialBootstrap cannot be called from execute code (hosted or --local). Call the MCP api tool with operationId "cliCredentialBootstrap" and run the returned cli_command.'

export const cliCredentialBootstrapCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'cliCredentialBootstrap',
		contextRuns: 'deny',
		orgPermission: 'none',
		description: `Sign the CLI in from the current Kody session without a second interactive OAuth: returns a one-shot \`kody_bc_…\` bootstrap code plus a CLI command. The CLI redeems the code over HTTPS for the same \`kody_at_…\` \`kody login\` mints (same scopes, 14-day idle / 3-month lifetime, never returned here) and saves it where \`kody login\` does. Pass \`scopes\` or \`lifetime\` only to make it narrower. Call it with the MCP \`api\` tool (operationId \`cliCredentialBootstrap\`); \`execute\` code (hosted or \`--local\`) is refused. Prefer this over \`tokenCreate\` for interactive agents already on MCP. Do not paste API tokens into chat. Interactive desktop humans who already ran \`kody login\` can skip this. CI/headless may still mint \`kody_at_\` directly. ${apiTokenIdleTtlDescription()}`,
		keywords: [
			'cli',
			'local execute',
			'bootstrap',
			'credential',
			'token',
			'login',
			'KODY_API_TOKEN',
			'auth',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			if (!ctx.openApiPrincipal || ctx.localExecuteHop) {
				throw new McpCallerError(cliCredentialBootstrapExecuteRefusal)
			}
			const user = requireMcpUser(ctx.callerContext)
			const input = inputSchema.parse(args ?? {})
			const storageContext = ctx.callerContext.storageContext
			if (storageContext?.packageId || storageContext?.appId) {
				throw new McpCallerError(
					'cliCredentialBootstrap cannot run inside saved-package, job, webhook, or app runtimes. Call it from the MCP api tool or the Open API.',
				)
			}
			if (ctx.callerContext.request?.credential.profileId) {
				throw new McpCallerError(
					'cliCredentialBootstrap is not available to a profile. Mint a profile token with tokenCreate (profile_id) or profileHandoff instead.',
				)
			}
			const parentToken =
				ctx.openApiPrincipal?.kind === 'token'
					? ctx.openApiPrincipal.token
					: undefined
			const credentialScopes = ctx.callerContext.request?.credential.scopes
			// A child never exceeds its parent: an API token caps scopes and
			// absolute expiry; a session that narrows scopes caps scopes.
			const parent = parentToken
				? {
						scopes: parentToken.scopes,
						maxExpiresAt: parentToken.max_expires_at,
					}
				: credentialScopes
					? {
							scopes: credentialScopes,
							maxExpiresAt: new Date(
								Date.now() + apiTokenPolicy.maxMaxLifetimeSeconds * 1000,
							).toISOString(),
						}
					: undefined
			// An org-bound parent token must not widen into a user-owned child.
			const orgBoundParent =
				parentToken?.org_binding === 'org' ? parentToken : undefined
			return mintCliCredentialBootstrap({
				db: ctx.env.APP_DB,
				// person-keyed (not personal org): api_tokens.user_id is the person
				userId: personalOrgId(user.userId),
				orgId: orgBoundParent
					? orgBoundParent.org_id
					: (ctx.callerContext.request?.org.id ?? personalOrgIdForPerson(user)),
				...(orgBoundParent ? { orgBinding: 'org' as const } : {}),
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.scopes === undefined ? {} : { scopes: input.scopes }),
				...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
				...(input.idle_ttl_seconds === undefined
					? {}
					: { idleTtlSeconds: input.idle_ttl_seconds }),
				...(input.max_lifetime_seconds === undefined
					? {}
					: { maxLifetimeSeconds: input.max_lifetime_seconds }),
				...(input.redeem_ttl_seconds === undefined
					? {}
					: { redeemTtlSeconds: input.redeem_ttl_seconds }),
				...(parent ? { parent } : {}),
			})
		},
	},
)

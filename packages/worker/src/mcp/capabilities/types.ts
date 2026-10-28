import { type JsonSchemaToolDescriptor } from '@cloudflare/codemode'
import { z, type ZodType } from 'zod'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { type SurfacePermission } from '#worker/authorization/authorize.ts'
import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'
import { type ApiTokenRecord } from '#worker/api-tokens/service.ts'
import { type CapabilityDomain } from './domain-metadata.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type McpReportProgress } from '#mcp/progress.ts'

export const emptyCapabilityInputSchema = z.object({})

/**
 * When a capability is invoked via the Open API (HTTP, MCP `api`, or the
 * CapabilityProxy hop behind `execute --local`), the authenticated principal.
 * Absent for hosted MCP `execute`. Token principals must not escalate scopes
 * when minting credentials.
 */
export type CapabilityOpenApiPrincipal =
	| { kind: 'token'; token: ApiTokenRecord }
	| { kind: 'mcp' }
	| { kind: 'mcp-oauth' }
	| { kind: 'execution-context-run'; ecid: string; runId: string }

export type CapabilityContext = {
	env: Env
	callerContext: McpCallerContext
	/**
	 * Best-effort MCP `notifications/progress` reporter when the client sent
	 * `_meta.progressToken`. Absent for non-MCP callers and when the client
	 * did not request progress.
	 */
	reportProgress?: McpReportProgress
	/**
	 * Prefer scheduling non-critical post-response work here (typically
	 * `ctx.waitUntil`) so publish/install responses stay snappy.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
	/** Set only when this capability runs as an Open API operation. */
	openApiPrincipal?: CapabilityOpenApiPrincipal
	/**
	 * Set by the CapabilityProxy when the call is a `kody:runtime` hop from
	 * `execute --local` code. Host-set, never read from module args, so local
	 * code cannot clear it. Hosted execute has no `openApiPrincipal`.
	 */
	localExecuteHop?: true
}

export type CapabilityResult = unknown

/**
 * Whether a run on a registered execution context may call this capability
 * (ECP 8.2). `deny` covers execute and anything that dispatches or schedules
 * runs, token, credential and access management, member and team
 * management, package publish and delete, and execution context management.
 */
export type CapabilityContextRunsPolicy = 'allow' | 'deny'

export type CapabilityJsonSchema = JsonSchemaToolDescriptor['inputSchema']

// Capability authors may provide Zod or raw JSON Schema.
export type CapabilitySchemaDefinition = CapabilityJsonSchema | ZodType

export type CapabilitySource = 'builtin' | 'mcp-server'

export type CapabilityMcpServerMetadata = {
	serverId: string
	serverName: string
	kodyName: string
	mcpToolName: string
	toolName: string
}

export type InferCapabilitySchema<TSchema> =
	TSchema extends ZodType<infer TOutput> ? TOutput : Record<string, unknown>

// Authoring-time shape before schemas are normalized to JSON Schema.
export type CapabilityDefinition<
	TInputSchema extends CapabilitySchemaDefinition = CapabilitySchemaDefinition,
	TOutputSchema extends CapabilitySchemaDefinition | undefined =
		| CapabilitySchemaDefinition
		| undefined,
> = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords?: Array<string>
	tags?: Array<string>
	readOnly?: boolean
	idempotent?: boolean
	destructive?: boolean
	/**
	 * Org permission the caller must hold to call this capability, checked
	 * at dispatch by `authorizeSurface`. Handlers still `authorize` the
	 * concrete resource they touch.
	 */
	orgPermission: SurfacePermission
	/** Required: whether execution context runs may call it. */
	contextRuns: CapabilityContextRunsPolicy
	/**
	 * The capability needs a live person: role, membership, and invite
	 * changes. It never runs from a triggered run (cron
	 * job, webhook, subscription, inbound email) or package code one started,
	 * whatever the enabler's role. `true` always applies; a function decides
	 * from the parsed input. Checked at dispatch by `assertLivePerson`.
	 */
	requiresLivePerson?:
		| true
		| ((
				args: InferCapabilitySchema<TInputSchema>,
				ctx: CapabilityContext,
		  ) => boolean | Promise<boolean>)
	/** Site-admin role (separate from org permissions). */
	requiredRole?: RoleName
	/** Site-admin permission (separate from org permissions). */
	requiredPermission?: PermissionString
	featureFlag?: FeatureFlagKey
	source?: CapabilitySource
	mcpServer?: CapabilityMcpServerMetadata
	inputSchema: TInputSchema
	outputSchema?: TOutputSchema
	handler: (
		args: InferCapabilitySchema<TInputSchema>,
		ctx: CapabilityContext,
	) => Promise<CapabilityOutput<TOutputSchema>>
}

export type CapabilityOutput<TOutputSchema> =
	TOutputSchema extends CapabilitySchemaDefinition
		? InferCapabilitySchema<TOutputSchema>
		: CapabilityResult

// Runtime/registry shape after schema normalization. `TResult` keeps the
// declared output type for direct callers; the registry uses the default.
export type Capability<TResult = CapabilityResult> = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	orgPermission: SurfacePermission
	contextRuns: CapabilityContextRunsPolicy
	/** `by-input`: the definition decides per call from the parsed input. */
	requiresLivePerson: 'always' | 'by-input' | 'never'
	requiredRole?: RoleName
	requiredPermission?: PermissionString
	featureFlag?: FeatureFlagKey
	source: CapabilitySource
	mcpServer?: CapabilityMcpServerMetadata
	inputSchema: CapabilityJsonSchema
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	inputTypeDefinition: string
	outputTypeDefinition?: string
	handler: (
		args: Record<string, unknown>,
		ctx: CapabilityContext,
	) => Promise<TResult>
}

export type CapabilitySpec = {
	name: string
	domain: CapabilityDomain
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	orgPermission: SurfacePermission
	requiredRole?: RoleName
	requiredPermission?: PermissionString
	featureFlag?: FeatureFlagKey
	source: CapabilitySource
	mcpServer?: CapabilityMcpServerMetadata
	inputFields: Array<string>
	requiredInputFields: Array<string>
	outputFields: Array<string>
	inputSchema: JsonSchemaToolDescriptor['inputSchema']
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	inputTypeDefinition: string
	outputTypeDefinition?: string
}

/** Registry / MCP instruction row derived from a `DomainSpec`. */
export type CapabilityDomainMetadata = {
	name: CapabilityDomain
	description: string
	keywords?: Array<string>
}

/**
 * Single source of truth for a domain: metadata plus its kody.
 * Pass an array of these to `buildCapabilityRegistry` (see `builtin-domains.ts`).
 */
export type DomainSpec = {
	name: CapabilityDomain
	description: string
	keywords?: Array<string>
	/**
	 * When true, the domain and its capabilities stay callable by exact name
	 * but are omitted from search, domain browse, and MCP domain instructions.
	 */
	unadvertised?: boolean
	capabilities: Array<Capability>
}

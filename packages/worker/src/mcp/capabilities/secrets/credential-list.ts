import { z } from 'zod'
import { listCredentialsForViewer } from '#worker/credentials/credential-list.ts'
import { filterCredentialList } from '#universal/credentials-list.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { credentialKinds } from '#universal/credential-contracts.ts'

const injectSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('header'), name: z.string(), format: z.string() }),
	z.object({
		kind: z.literal('basic'),
		valueAs: z.enum(['username', 'password']),
		other: z.string(),
	}),
	z.object({ kind: z.literal('query'), param: z.string() }),
])

const credentialListItemSchema = z.object({
	id: z.string().describe('Credential id (accessGrant, credentialUpdate).'),
	kind: z.enum(credentialKinds),
	name: z.string(),
	scope: z
		.enum(['org', 'personal'])
		.describe('personal: your own credential granted to this org.'),
	provider: z.string().nullable(),
	description: z.string(),
	hosts: z.array(z.string()),
	inject: injectSchema.nullable(),
	placement: z
		.object({
			headers: z.union([z.literal(true), z.array(z.string())]).optional(),
			query: z.literal(true).optional(),
			path: z.literal(true).optional(),
			body: z.literal(true).optional(),
		})
		.nullable()
		.describe(
			'Where placeholders may be filled (headers, query, path, body). Null means anywhere. Distinct from inject.',
		),
	packageId: z
		.string()
		.nullable()
		.describe('Set for a package-scoped Key: the package it belongs to.'),
	lockedToPackageIds: z
		.array(z.string())
		.describe('Non-empty when only these packages may use it.'),
	expiresAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	status: z.enum(['ok', 'expired', 'needs_attention', 'disabled']),
	statusMessage: z.string().nullable(),
	mcp: z.object({ url: z.string(), enabled: z.boolean() }).nullable(),
})

export const credentialListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialList',
		orgPermission: 'none',
		description:
			'List every credential you can use in this org as one shape: Keys (secrets) and the opt-in url, login, and signing kinds, OAuth integrations, and MCP servers (kind "mcp"). Includes your own personal credentials granted to this org (scope "personal"). Filter by text, kind, scope, package-scoped Keys, or package locks. Metadata only: never values. To add one, send the person to /connect/credential (kind, kindMode=hint|required, name, provider, allowedHosts).',
		keywords: [
			'credential',
			'credentials',
			'list',
			'secret',
			'integration',
			'oauth',
			'mcp',
			'server',
			'locked',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			q: z
				.string()
				.optional()
				.describe('Substring of name, provider, description, or host.'),
			kinds: z.array(z.enum(credentialKinds)).optional(),
			scope: z.enum(['org', 'personal']).optional(),
			packageScoped: z
				.boolean()
				.optional()
				.describe('true: only package-scoped Keys; false: exclude them.'),
			locked: z
				.union([z.literal(true), z.string().min(1)])
				.optional()
				.describe('true: locked to any package; a package id: locked to it.'),
		}),
		outputSchema: z.object({ credentials: z.array(credentialListItemSchema) }),
		async handler(args, ctx: CapabilityContext) {
			const request = requireMcpRequest(ctx.callerContext)
			const { authorityPackageId } = resolveCallerSecretAuthority({
				storageContext: ctx.callerContext.storageContext,
			})
			if (authorityPackageId) {
				throw new McpCallerError(
					'Package code cannot list credentials. Use credential(key) for the needs the package declares.',
				)
			}
			const credentials = await listCredentialsForViewer({
				env: ctx.env,
				request,
			})
			// Open API query strings carry `locked=true` as the string "true".
			const locked = args.locked === 'true' ? true : args.locked
			return {
				credentials: filterCredentialList(credentials, { ...args, locked }),
			}
		},
	},
)

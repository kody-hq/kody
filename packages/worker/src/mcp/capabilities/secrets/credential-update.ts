import { z } from 'zod'
import { authorize } from '#worker/authorization/authorize.ts'
import {
	credentialFillPlacementSchema,
	credentialInjectSchema,
	credentialProviderSchema,
	readCredentialFields,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import {
	assertPlaceholderSecretName,
	listKnownSecretNameReferences,
	secretRenameNameReferencesNote,
} from '#mcp/secrets/secret-name-references.ts'
import { findSecret, renameSecret } from '#mcp/secrets/service.ts'
import { assertCredentialSecurityEditAllowed } from './credential-security-edit.ts'

const inputSchema = z
	.object({
		credential_id: z
			.string()
			.min(1)
			.describe(
				'Credential id from secretList, the integrations list, or packageGet credential options.',
			),
		name: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(
				'New name for a user-scope secret (letters, numbers, dots, underscores, hyphens; unique in the account). Renames in place: the credential id, value, grants, package credential mappings, and history stay attached. {{secret:<old name>}} placeholders and code that names the secret do not follow; the response lists the known ones. Send it on its own, not with provider, inject, or placement.',
			),
		provider: credentialProviderSchema
			.nullable()
			.optional()
			.describe(
				'Provider slug (for example "github") package credential needs match against. Null clears it.',
			),
		inject: credentialInjectSchema
			.optional()
			.describe(
				'How a scoped credential client places a secret\'s value: a header with a "{value}" format, basic auth, or a query parameter. OAuth connections and MCP servers always use Authorization: Bearer. Changing it is website-only from execute, package, and app code.',
			),
		placement: credentialFillPlacementSchema
			.nullable()
			.optional()
			.describe(
				'Where placeholders for this credential may be filled: headers (optionally named), query, path, and/or body. Null means anywhere. New credentials default to headers-only. Distinct from inject. Applies to secrets, OAuth integration tokens, and vault bindings. From execute, package, and app code only narrowing works; widening is website-only.',
			),
	})
	.refine(
		(value) =>
			value.name !== undefined ||
			value.provider !== undefined ||
			value.inject ||
			value.placement !== undefined,
		{
			message: 'Provide name, provider, inject, and/or placement.',
		},
	)
	.refine(
		(value) =>
			value.name === undefined ||
			(value.provider === undefined &&
				!value.inject &&
				value.placement === undefined),
		{
			message:
				'Rename on its own call; send provider, inject, or placement in a separate credentialUpdate.',
		},
	)

const outputSchema = z.object({
	credential_id: z.string(),
	credential_kind: z.enum(['secret', 'integration', 'mcp-server', 'vault']),
	name: z.string(),
	provider: z.string().nullable(),
	inject: credentialInjectSchema,
	placement: credentialFillPlacementSchema.nullable(),
	rename: z
		.object({
			previous_name: z.string(),
			known_references: z.array(
				z.object({
					kind: z.enum(['webhook-verification', 'secret-provider-door']),
					id: z.string(),
					package_id: z.string(),
					label: z.string(),
				}),
			),
			note: z.string(),
		})
		.optional()
		.describe(
			'Present when the call renamed a secret: stored settings that still use the previous name, and what else to update.',
		),
})

export const credentialUpdateCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialUpdate',
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			"Rename a user-scope secret in place, or set a credential's provider, inject, and/or fill placement: which package credential needs it can satisfy, where a scoped `credential(key)` client puts its value, and which request parts placeholders may fill (headers, query, path, body). The gateway enforces placement; query, path, and body fill only after the owner opts in on the credential page, because the host may store the value (parts a credential filled before enforcement stay opted in). Works for user-scope secrets, OAuth connections, MCP servers (provider/inject only), and vault bindings (placement only) by credential id; needs Write on that credential and is audited. Renames keep the credential id and value; name-based references ({{secret:<name>}} placeholders, code that names the secret) do not follow, and the response lists the known ones. Never takes or returns a value. Widening placement or changing inject is website-only from execute (hosted or --local), package, and app code; those calls are refused with the credential's page URL.",
		keywords: [
			'credential',
			'provider',
			'inject',
			'header',
			'placement',
			'client',
			'rename',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(parsed, ctx: CapabilityContext) {
			const request = requireMcpRequest(ctx.callerContext)
			const { authorityPackageId } = resolveCallerSecretAuthority({
				storageContext: ctx.callerContext.storageContext,
			})
			if (authorityPackageId) {
				throw new McpCallerError(
					'Package runtimes cannot rename a credential or change its provider, inject, or placement.',
				)
			}
			const orgId = ownerIdFromCaller(ctx.callerContext)
			const credential = await getOrgCredential(
				ctx.env.APP_DB,
				orgId,
				parsed.credential_id,
			)
			if (!credential?.live) {
				await authorize(
					{ env: ctx.env, request },
					'secret:write',
					missingCredentialResource(request.org.id, parsed.credential_id),
				)
				throw new McpCallerError('No credential with that id in this org.')
			}
			await authorize(
				{ env: ctx.env, request },
				`${credentialPermissionFamily(credential.kind)}:write`,
				credentialResource(request.org.id, credential),
			)
			if (parsed.name !== undefined) {
				if (credential.kind !== 'secret') {
					throw new McpCallerError(
						'Only secrets can be renamed. Integrations, MCP servers, and vault bindings keep the name they were connected with.',
					)
				}
				const previousName = credential.name
				const accountSecret = await findSecret({
					env: ctx.env,
					userId: orgId,
					name: previousName,
					scope: 'user',
					includeExpired: true,
				})
				if (accountSecret.credentialId !== credential.id) {
					throw new McpCallerError(
						'Only account secrets can be renamed with credentialUpdate. Rename a package secret from its page on the website.',
					)
				}
				assertPlaceholderSecretName(parsed.name)
				const renamed = await renameSecret({
					env: ctx.env,
					userId: orgId,
					scope: 'user',
					fromName: previousName,
					toName: parsed.name,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				const fields = await readCredentialFields({
					db: ctx.env.APP_DB,
					credential: { ...credential, name: renamed.name },
				})
				return {
					credential_id: credential.id,
					credential_kind: credential.kind,
					name: renamed.name,
					provider: fields.provider,
					inject: fields.inject,
					placement: fields.placement,
					rename: {
						previous_name: previousName,
						known_references:
							previousName === renamed.name
								? []
								: await listKnownSecretNameReferences({
										db: ctx.env.APP_DB,
										orgId,
										name: previousName,
									}),
						note: secretRenameNameReferencesNote,
					},
				}
			}
			if (parsed.inject || parsed.placement !== undefined) {
				const before = await readCredentialFields({
					db: ctx.env.APP_DB,
					credential,
				})
				assertCredentialSecurityEditAllowed(ctx, {
					credential,
					before,
					after: {
						...(parsed.inject ? { inject: parsed.inject } : {}),
						...(parsed.placement !== undefined
							? { placement: parsed.placement }
							: {}),
					},
				})
			}
			const updated = await updateCredentialFields({
				db: ctx.env.APP_DB,
				orgId,
				credentialId: credential.id,
				update: {
					...(parsed.provider !== undefined
						? { provider: parsed.provider }
						: {}),
					...(parsed.inject ? { inject: parsed.inject } : {}),
					...(parsed.placement !== undefined
						? { placement: parsed.placement }
						: {}),
				},
				audit: orgAuditWriterFromRequest(ctx.env, request),
				placementOrigin: 'explicit',
			})
			return {
				credential_id: updated.credential.id,
				credential_kind: updated.credential.kind,
				name: updated.credential.name,
				provider: updated.provider,
				inject: updated.inject,
				placement: updated.placement,
			}
		},
	},
)

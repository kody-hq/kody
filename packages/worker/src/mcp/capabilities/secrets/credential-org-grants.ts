import { z } from 'zod'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type CredentialPermissionFamily } from '@kody-internal/shared/org-permissions.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { authorizeCredentialScope } from '#worker/authorization/authorize.ts'
import {
	credentialPermissionFamily,
	getOrgCredential,
	type CredentialKind,
} from '#worker/credentials/credential-ids.ts'
import {
	grantPersonalCredentialToOrg,
	listPersonalCredentialOrgGrants,
	revokePersonalCredentialOrgGrant,
} from '#worker/credentials/personal-credentials.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	loadPersonalOrgIdForPerson,
	personalOrgIdForPerson,
} from '#worker/orgs/personal-org-id.ts'
import { getOrgById, getOrgBySlug } from '#worker/orgs/repo.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'

const credentialIdField = z
	.string()
	.min(1)
	.describe(
		'Credential id of a secret, OAuth connection, or MCP server in your personal org (secretList or credentialList there).',
	)

const orgField = z
	.string()
	.min(1)
	.optional()
	.describe(
		'Slug of the org. Defaults to the org this request is bound to when that is not your personal org.',
	)

const grantKindSchema = z.enum(['secret', 'integration', 'mcp-server'])

const orgOutput = z.object({
	id: z.string(),
	slug: z.string(),
})

function requireOwner(ctx: CapabilityContext, action: string) {
	const request = requireMcpRequest(ctx.callerContext)
	const { authorityPackageId } = resolveCallerSecretAuthority({
		storageContext: ctx.callerContext.storageContext,
	})
	if (authorityPackageId) {
		throw new McpCallerError(
			`Package runtimes cannot ${action} personal credential grants.`,
		)
	}
	if (!request.actor) {
		throw new McpCallerError(
			'Personal credential grants belong to a person. This request has no acting person.',
		)
	}
	return { request, personId: request.actor.userId }
}

async function resolveTargetOrg(
	ctx: CapabilityContext,
	request: RequestContext,
	slug: string | undefined,
) {
	if (slug === undefined) {
		if (
			request.org.id ===
			personalOrgIdForPerson({
				userId: request.actor!.userId,
				personalOrgId: ctx.callerContext.user?.personalOrgId,
			})
		) {
			throw new McpCallerError(
				'This request is bound to your personal org, where your personal credentials already work. Pass org with the slug of the org to grant to.',
			)
		}
		const current = await getOrgById(ctx.env.APP_DB, request.org.id)
		if (!current)
			throw new McpCallerError('This request’s org no longer exists.')
		return { id: ownerIdFromStored(current.id), slug: current.slug }
	}
	const org = await getOrgBySlug(ctx.env.APP_DB, slug)
	if (!org) throw new McpCallerError(`No org with the slug "${slug}".`)
	return { id: ownerIdFromStored(org.id), slug: org.slug }
}

/**
 * Write on the family of the owner's credential, deleted or not, so a grant
 * outliving its credential still needs the right family. An id with no row
 * in the owner's personal org needs Write on every family.
 */
async function authorizeGrantChange(
	ctx: CapabilityContext,
	request: RequestContext,
	credentialId: string,
) {
	const credential = await getOrgCredential(
		ctx.env.APP_DB,
		await loadPersonalOrgIdForPerson(ctx.env.APP_DB, request.actor!.userId),
		credentialId,
	)
	const families: Array<CredentialPermissionFamily> = credential
		? [credentialPermissionFamily(credential.kind)]
		: ['secret', 'integration']
	for (const family of families) {
		authorizeCredentialScope(request, `${family}:write`)
	}
}

function toGrantKind(kind: CredentialKind): z.infer<typeof grantKindSchema> {
	switch (kind) {
		case 'secret':
		case 'integration':
		case 'mcp-server':
			return kind
		case 'vault':
			throw new Error('Vault bindings are never personal credentials.')
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

export const credentialOrgGrantCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialOrgGrant',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Grant one of your personal credentials (a secret, OAuth connection, or MCP server in your personal org) to an org you belong to (ADR 0068). It then works in that org only in your own runs: through scoped `credential(key)` clients, `{{secret:name}}` and `{{integration-token:name}}` placeholders, and `createAuthenticatedFetch(name)` (an org credential with the same name wins first). Nobody else there can use it, Owners and Automation included. Granting again is a no-op. Needs Write on the credential (a token needs secret:write, or integration:write for OAuth connections and MCP servers) and a live person, and is audited in your personal org. Never takes or returns a value.',
		keywords: ['credential', 'personal', 'grant', 'share', 'org', 'team'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			credential_id: credentialIdField,
			org: orgField,
		}),
		outputSchema: z.object({
			credential_id: z.string(),
			credential_kind: grantKindSchema,
			name: z.string(),
			org: orgOutput,
			created: z
				.boolean()
				.describe('False when the credential was already granted to the org.'),
		}),
		async handler(parsed, ctx: CapabilityContext) {
			const { request, personId } = requireOwner(ctx, 'change')
			await authorizeGrantChange(ctx, request, parsed.credential_id)
			const org = await resolveTargetOrg(ctx, request, parsed.org)
			const granted = await grantPersonalCredentialToOrg({
				db: ctx.env.APP_DB,
				ownerPersonId: personId,
				credentialId: parsed.credential_id,
				orgId: org.id,
				audit: orgAuditWriterFromRequest(ctx.env, request),
			})
			return {
				credential_id: granted.id,
				credential_kind: toGrantKind(granted.kind),
				name: granted.name,
				org,
				created: granted.created,
			}
		},
	},
)

export const credentialOrgRevokeCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialOrgRevoke',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			"Revoke one org's grant of your personal credential (ADR 0068). Your runs in that org stop resolving it right away; the credential itself stays in your personal org. Needs Write on the credential and a live person, and is audited in your personal org.",
		keywords: ['credential', 'personal', 'revoke', 'unshare', 'org', 'grant'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			credential_id: credentialIdField,
			org: orgField,
		}),
		outputSchema: z.object({
			credential_id: z.string(),
			org: orgOutput,
			revoked: z
				.boolean()
				.describe('False when the credential was not granted to the org.'),
		}),
		async handler(parsed, ctx: CapabilityContext) {
			const { request, personId } = requireOwner(ctx, 'change')
			await authorizeGrantChange(ctx, request, parsed.credential_id)
			const org = await resolveTargetOrg(ctx, request, parsed.org)
			const revoked = await revokePersonalCredentialOrgGrant({
				db: ctx.env.APP_DB,
				ownerPersonId: personId,
				credentialId: parsed.credential_id,
				orgId: org.id,
				audit: orgAuditWriterFromRequest(ctx.env, request),
			})
			return { credential_id: parsed.credential_id, org, revoked }
		},
	},
)

export const credentialOrgGrantListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialOrgGrantList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			"List the orgs your personal credentials are granted to (ADR 0068), optionally for one credential. `active` is false when a grant does not work right now: the credential's value expired, its OAuth connection is disconnected, its MCP server is disabled, or you no longer belong to the org. Lists only your own grants, never anyone else's. Never returns values.",
		keywords: ['credential', 'personal', 'grant', 'list', 'org', 'shared'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			credential_id: credentialIdField.optional(),
		}),
		outputSchema: z.object({
			grants: z.array(
				z.object({
					credential_id: z.string(),
					credential_kind: grantKindSchema,
					name: z.string(),
					org: orgOutput.extend({ display_name: z.string().nullable() }),
					created_at: z.string(),
					active: z.boolean(),
				}),
			),
		}),
		async handler(parsed, ctx: CapabilityContext) {
			const { request, personId } = requireOwner(ctx, 'read')
			const scopes = request.credential.scopes
			const readable = (kind: CredentialKind) =>
				!scopes || scopes.includes(`${credentialPermissionFamily(kind)}:read`)
			if (request.credential.profileName) {
				authorizeCredentialScope(request, 'secret:read')
			}
			const grants = await listPersonalCredentialOrgGrants({
				db: ctx.env.APP_DB,
				ownerPersonId: personId,
				...(parsed.credential_id ? { credentialId: parsed.credential_id } : {}),
			})
			return {
				grants: grants
					.filter(
						(grant) =>
							grant.credential.kind !== 'vault' &&
							readable(grant.credential.kind),
					)
					.map((grant) => ({
						credential_id: grant.credential.id,
						credential_kind: toGrantKind(grant.credential.kind),
						name: grant.credential.name,
						org: {
							id: grant.org.id,
							slug: grant.org.slug,
							display_name: grant.org.displayName,
						},
						created_at: grant.createdAt,
						active: grant.active,
					})),
			}
		},
	},
)

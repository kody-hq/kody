import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeSurface } from '#worker/authorization/authorize.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	createPackageLockMessage,
	type PackageLockOutcome,
} from '#mcp/secrets/allowed-packages.ts'
import { resolveSecretPageOrgSlug } from '#mcp/secrets/package-access.ts'
import {
	buildSecretPackageApprovalUrl,
	buildSecretUsageUrl,
} from '#mcp/secrets/package-approval-url.ts'
import { inspectUserSecretPackageGrant } from '#mcp/secrets/service.ts'
import {
	buildSecretProviderPackageApprovalUrl,
	buildSecretProviderUsageUrl,
} from '#mcp/secrets/secret-providers/approval-url.ts'
import { inspectSecretProviderPackageGrant } from '#mcp/secrets/secret-providers/service.ts'
import {
	authorizeIntegration,
	authorizeMcpServer,
} from '#mcp/capabilities/integrations/authorize-integration.ts'
import { authorizeSecret, authorizeSecretOrgWide } from './authorize-secret.ts'
import { canonicalIntegrationName } from '../integrations/integration-shared.ts'
import {
	buildIntegrationPackageApprovalUrl,
	buildIntegrationUsageUrl,
} from '#worker/integrations/package-access.ts'
import { lockIntegrationToPackage } from '#worker/integrations/service.ts'
import {
	buildMcpServerPackageApprovalUrl,
	buildMcpServerUsageUrl,
} from '#worker/mcp-client/package-access.ts'
import { lockMcpServerToPackage } from '#worker/mcp-client/settings-service.ts'
import { resolveMcpServerSetting } from '../mcp-servers/shared.ts'

const nonEmptyString = (description: string) =>
	z.string().min(1).describe(description)

const inputSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z
			.literal('secret')
			.describe(
				'User-scoped secret (returns an approval URL; does not grant).',
			),
		name: nonEmptyString('User-scoped secret name to grant.'),
		package_id: nonEmptyString('Saved package id that may use this secret.'),
	}),
	z.object({
		kind: z
			.literal('secret_provider')
			.describe(
				'External secret-provider ref (returns an approval URL; does not grant).',
			),
		provider: nonEmptyString('Provider id, for example 1password.'),
		ref: nonEmptyString(
			'Canonical i/<item-id>/<field> ref (UUID or 1Password Connect 26-char id), or an op:// synonym that already contains that item id.',
		),
		package_id: nonEmptyString(
			'Saved package id that may use this provider ref.',
		),
	}),
	z.object({
		kind: z
			.literal('integration')
			.describe(
				'Saved OAuth integration (locks an unlocked connection; adding a package to a locked one returns an approval URL).',
			),
		name: nonEmptyString('Saved integration connection name (provider key).'),
		package_id: nonEmptyString(
			'Saved package id that may use this integration.',
		),
	}),
	z.object({
		kind: z
			.literal('mcp_server')
			.describe(
				'Saved MCP server (locks an unlocked server; adding a package to a locked one returns an approval URL).',
			),
		server: nonEmptyString('The saved MCP server id or name.'),
		package_id: nonEmptyString(
			'Saved package id that may call this MCP server.',
		),
	}),
])

const lockResultFields = {
	usage_url: z.string(),
	status: z.enum(['locked', 'already_granted', 'approval_required']),
	approval_url: z.string(),
	message: z.string(),
}

const packageLockOutputFields = {
	usage_mode: z.literal('packages'),
	allowed_package_ids: z.array(z.string()),
	...lockResultFields,
}

const outputSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('secret'),
		name: z.string(),
		scope: z.literal('user'),
		allowed_packages: z.array(z.string()),
		...lockResultFields,
	}),
	z.object({
		kind: z.literal('secret_provider'),
		provider: z.string(),
		canonical_ref: z.string(),
		package_id: z.string(),
		...lockResultFields,
	}),
	z.object({
		kind: z.literal('integration'),
		name: z.string(),
		...packageLockOutputFields,
	}),
	z.object({
		kind: z.literal('mcp_server'),
		id: z.string(),
		name: z.string(),
		...packageLockOutputFields,
	}),
])

type ResourceLockInput = z.infer<typeof inputSchema>

function toCallerError(error: unknown, fallback: string): never {
	if (error instanceof McpCallerError) throw error
	throw new McpCallerError(error instanceof Error ? error.message : fallback, {
		cause: error,
	})
}

/** The one result shape every kind returns. Only the owner widens a lock. */
function lockResult(input: {
	outcome: PackageLockOutcome
	resource: string
	packageName: string
	usageUrl: string
	approvalUrl: string
}) {
	return {
		usage_url: input.usageUrl,
		status: input.outcome,
		approval_url: input.approvalUrl,
		message: createPackageLockMessage(input),
	}
}

function resourceUsageOrgSlug(
	ctx: CapabilityContext,
	user: NonNullable<typeof ctx.callerContext.user>,
) {
	return (
		ctx.callerContext.request?.org.slug?.trim() || user.username?.trim() || ''
	)
}

async function handleSecret(
	args: Extract<ResourceLockInput, { kind: 'secret' }>,
	ctx: CapabilityContext,
) {
	await authorizeSecret(ctx, 'secret:use', {
		name: args.name,
		scope: 'user',
	})
	try {
		const state = await inspectUserSecretPackageGrant({
			env: ctx.env,
			userId: ownerIdFromCaller(ctx.callerContext),
			name: args.name,
			packageId: args.package_id,
		})
		const orgSlug = await resolveSecretPageOrgSlug({
			db: ctx.env.APP_DB,
			userId: ownerIdFromCaller(ctx.callerContext),
			caller: ctx.callerContext,
		})
		if (!orgSlug) {
			throw new McpCallerError(
				'Unable to build a secrets page URL because this account has no org slug.',
			)
		}
		const approvalUrl = buildSecretPackageApprovalUrl({
			baseUrl: ctx.callerContext.baseUrl,
			orgSlug,
			name: state.secret.name,
			scope: 'user',
			packageId: state.savedPackage.id,
			kodyId: state.savedPackage.kodyId,
			storageContext: null,
		})
		const usageUrl = buildSecretUsageUrl({
			baseUrl: ctx.callerContext.baseUrl,
			orgSlug,
			name: state.secret.name,
		})
		return {
			kind: 'secret' as const,
			name: state.secret.name,
			scope: 'user' as const,
			allowed_packages: state.secret.allowedPackages,
			...lockResult({
				outcome: state.alreadyGranted ? 'already_granted' : 'approval_required',
				resource: `secret "${state.secret.name}"`,
				packageName: state.savedPackage.kodyId,
				usageUrl,
				approvalUrl,
			}),
		}
	} catch (error) {
		toCallerError(error, 'Unable to inspect this secret package grant.')
	}
}

async function handleSecretProvider(
	args: Extract<ResourceLockInput, { kind: 'secret_provider' }>,
	ctx: CapabilityContext,
) {
	await authorizeSecretOrgWide(ctx, 'secret:use')
	try {
		const state = await inspectSecretProviderPackageGrant({
			env: ctx.env,
			userId: ownerIdFromCaller(ctx.callerContext),
			providerId: args.provider,
			ref: args.ref,
			packageId: args.package_id,
		})
		const approvalUrl = buildSecretProviderPackageApprovalUrl({
			baseUrl: ctx.callerContext.baseUrl,
			providerId: state.providerId,
			canonicalRef: state.canonicalRef,
			packageId: state.savedPackage.id,
			kodyId: state.savedPackage.kodyId,
		})
		const usageUrl = buildSecretProviderUsageUrl({
			baseUrl: ctx.callerContext.baseUrl,
		})
		return {
			kind: 'secret_provider' as const,
			provider: state.providerId,
			canonical_ref: state.canonicalRef,
			package_id: state.savedPackage.id,
			...lockResult({
				outcome: state.alreadyGranted ? 'already_granted' : 'approval_required',
				resource: `provider ref "${state.canonicalRef}"`,
				packageName: state.savedPackage.kodyId,
				usageUrl,
				approvalUrl,
			}),
		}
	} catch (error) {
		toCallerError(error, 'Unable to inspect this secret provider grant.')
	}
}

async function handleIntegration(
	args: Extract<ResourceLockInput, { kind: 'integration' }>,
	ctx: CapabilityContext,
	orgSlug: string,
) {
	await authorizeIntegration(
		ctx,
		'integration:use',
		canonicalIntegrationName(args.name),
	)
	try {
		const { outcome, connection, packageKodyId } =
			await lockIntegrationToPackage({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				name: args.name,
				packageId: args.package_id,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
		return {
			kind: 'integration' as const,
			name: connection.name,
			usage_mode: 'packages' as const,
			allowed_package_ids: connection.allowedPackageIds,
			...lockResult({
				outcome,
				resource: `integration "${connection.name}"`,
				packageName: packageKodyId,
				usageUrl: buildIntegrationUsageUrl({
					baseUrl: ctx.callerContext.baseUrl,
					orgSlug,
					name: connection.name,
				}),
				approvalUrl: buildIntegrationPackageApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					orgSlug,
					name: connection.name,
					packageId: args.package_id.trim(),
					kodyId: packageKodyId,
				}),
			}),
		}
	} catch (error) {
		toCallerError(error, 'Unable to lock this integration to a package.')
	}
}

async function handleMcpServer(
	args: Extract<ResourceLockInput, { kind: 'mcp_server' }>,
	ctx: CapabilityContext,
	orgSlug: string,
) {
	const setting = await resolveMcpServerSetting({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		server: args.server,
	})
	await authorizeMcpServer(ctx, 'integration:use', setting)
	try {
		const { outcome, server, packageKodyId } = await lockMcpServerToPackage({
			env: ctx.env,
			userId: ownerIdFromCaller(ctx.callerContext),
			id: setting.id,
			packageId: args.package_id,
			audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
		})
		return {
			kind: 'mcp_server' as const,
			id: server.id,
			name: server.name,
			usage_mode: 'packages' as const,
			allowed_package_ids: server.allowedPackageIds,
			...lockResult({
				outcome,
				resource: `MCP server "${server.name}"`,
				packageName: packageKodyId,
				usageUrl: buildMcpServerUsageUrl({
					baseUrl: ctx.callerContext.baseUrl,
					orgSlug,
					serverId: server.id,
				}),
				approvalUrl: buildMcpServerPackageApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					orgSlug,
					serverId: server.id,
					packageId: args.package_id.trim(),
					kodyId: packageKodyId,
				}),
			}),
		}
	} catch (error) {
		toCallerError(error, 'Unable to lock this MCP server to a package.')
	}
}

export const resourceLockCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'resourceLock',
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			'Narrow a credential-like resource to a saved package; unlock or removal is website-only, and this capability can never widen usage. Every kind returns status (locked, already_granted, or approval_required) and an approval_url. approval_required means nothing changed: send the owner the approval_url and wait; never treat it as a grant. Kinds secret and secret_provider require secret:use and always need owner approval (secret page /@<slug>/-/secrets/approve); ad hoc execute does not need provider grants, but saved packages do. Kinds integration and mcp_server require integration:use: locking a connection any context can use to its first package applies immediately (status locked), and adding a package to an already locked connection needs owner approval. Unlock at /account/integrations/:name or /account/mcp-servers/:serverId. integrationSave cannot change usageMode, and secretSet cannot change allowed_packages.',
		keywords: [
			'secret',
			'lock',
			'package',
			'usage',
			'restrict',
			'grant',
			'allowed_packages',
			'approval',
			'provider',
			'1password',
			'integration',
			'oauth',
			'token',
			'mcp',
			'server',
			'client',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args: ResourceLockInput, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const kindPermission = {
				secret: 'secret:use',
				secret_provider: 'secret:use',
				integration: 'integration:use',
				mcp_server: 'integration:use',
			} as const satisfies Record<ResourceLockInput['kind'], OrgPermission>
			await authorizeSurface(
				{ env: ctx.env, request: ctx.callerContext.request },
				kindPermission[args.kind],
			)
			switch (args.kind) {
				case 'secret':
					return handleSecret(args, ctx)
				case 'secret_provider':
					return handleSecretProvider(args, ctx)
				case 'integration':
					return handleIntegration(args, ctx, resourceUsageOrgSlug(ctx, user))
				case 'mcp_server':
					return handleMcpServer(args, ctx, resourceUsageOrgSlug(ctx, user))
			}
		},
	},
)

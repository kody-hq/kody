import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import {
	deleteSecret,
	disconnectSecret,
	findSecret,
} from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { authorizeSecret } from './authorize-secret.ts'
import { assertPackageScopedSecretWriteAvailable } from './package-scoped-secret-write.ts'

export const secretDeleteCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretDelete',
		contextRuns: 'deny',
		orgPermission: 'secret:delete',
		description:
			'Delete an existing secret reference for the signed-in user: removes the credential row and every record of it (including placement and grants). Plaintext values stay hidden. Distinct from secretDisconnect, which clears only the value and keeps the row. Prefer secretDisconnect for package Connect/Disconnect flows that should preserve placement. When a package runtime calls this on a package-scope secret, the platform disconnects instead of deleting so existing package Disconnect code keeps placement.',
		keywords: ['secret', 'delete', 'remove', 'revoke', 'credential'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			name: z.string().min(1).describe('Secret name to delete.'),
			scope: z
				.enum(secretScopeValues)
				.describe('Scope that owns the secret being deleted.'),
		}),
		outputSchema: z.object({
			deleted: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const { authorityPackageId, storageContext } =
				resolveCallerSecretAuthority({
					storageContext: ctx.callerContext.storageContext,
				})
			assertPackageScopedSecretWriteAvailable({
				scope: args.scope,
				storageContext,
			})
			// Package-runtime Disconnect historically called secretDelete on
			// package-scope secrets. Map that to disconnect so placement survives.
			const packageRuntimeDisconnect =
				args.scope === 'package' && Boolean(authorityPackageId)
			await authorizeSecret(
				ctx,
				packageRuntimeDisconnect ? 'secret:write' : 'secret:delete',
				{
					name: args.name,
					scope: args.scope,
					storageContext,
				},
			)
			if (args.scope === 'user' && authorityPackageId) {
				const existing = await findSecret({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					name: args.name,
					scope: 'user',
					storageContext,
				})
				if (existing.found) {
					await assertPackageCanAccessResolvedSecret({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
						userId: ownerIdFromCaller(ctx.callerContext),
						storageContext,
						authorityPackageId,
						secretName: args.name,
						resolved: existing,
						intent: 'mutate',
					})
				}
			}
			if (packageRuntimeDisconnect) {
				const disconnected = await disconnectSecret({
					env: ctx.env,
					audit:
						args.scope === 'user'
							? orgAuditWriterFromCaller(ctx.env, ctx.callerContext)
							: null,
					userId: ownerIdFromCaller(ctx.callerContext),
					name: args.name,
					scope: args.scope,
					storageContext,
				})
				return { deleted: disconnected }
			}
			return {
				deleted: await deleteSecret({
					env: ctx.env,
					audit:
						args.scope === 'user'
							? orgAuditWriterFromCaller(ctx.env, ctx.callerContext)
							: null,
					userId: ownerIdFromCaller(ctx.callerContext),
					name: args.name,
					scope: args.scope,
					storageContext,
				}),
			}
		},
	},
)

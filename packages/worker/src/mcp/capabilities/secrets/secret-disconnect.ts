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
import { disconnectSecret, findSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { authorizeSecret } from './authorize-secret.ts'
import { assertPackageScopedSecretWriteAvailable } from './package-scoped-secret-write.ts'

export const secretDisconnectCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretDisconnect',
		contextRuns: 'deny',
		orgPermission: 'secret:write',
		description:
			'Disconnect a secret: clear its value but keep the credential row, placement, hosts, and grants. Reconnect with secretSet (same name) to restore the value into the same row. Distinct from secretDelete, which removes the credential and every record of it. Package Connect/Disconnect flows that previously called secretDelete on package-scope secrets should use this instead; package-runtime secretDelete on package scope also disconnects for compatibility.',
		keywords: [
			'secret',
			'disconnect',
			'clear',
			'credential',
			'placement',
			'reconnect',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('Secret name to disconnect.'),
			scope: z
				.enum(secretScopeValues)
				.describe('Scope that owns the secret being disconnected.'),
		}),
		outputSchema: z.object({
			disconnected: z.boolean(),
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
			await authorizeSecret(ctx, 'secret:write', {
				name: args.name,
				scope: args.scope,
				storageContext,
			})
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
			return {
				disconnected: await disconnectSecret({
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

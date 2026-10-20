import { listScopeIncludes } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { packageHasImplicitUserSecretReadAccess } from '#mcp/secrets/package-access.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { loadSecretListScope } from './authorize-secret.ts'
import { listedSecretSchema, toListedSecretCapabilityOutput } from './shared.ts'

export const secretListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretList',
		orgPermission: 'secret:use',
		description:
			'List available secret references for the signed-in user. Results include metadata such as names, credential ids (for accessGrant), descriptions, allowed hosts, allowed packages, and package_id for package-scoped secrets — never plaintext values. Explicit listing includes caller-owned package-scoped metadata from execute (no package runtime); using a package secret still requires package context. From a package runtime, self-authored and adopted packages see user secrets they can already read; unadopted community forks see only explicitly granted user secrets. Listing a secret does not approve a host: outbound `fetch` still resolves `{{secret:name}}` (optionally `{{secret:name|scope=user}}`) only for approved hosts. Use `kody.secretList({ scope })` inside execute-time code for the same metadata. Use `/connect/secret-set` for user-provided API key, token, and credential entry or rotation.',
		keywords: ['secret', 'list', 'discovery', 'metadata', 'credentials'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			scope: z
				.enum(secretScopeValues)
				.optional()
				.describe(
					'Optional scope filter. When omitted, list all accessible scopes. Package-scoped metadata is included for caller-owned secrets (with package_id) even without a package runtime; session secrets stay session-bound. Using a package secret still requires package context.',
				),
		}),
		outputSchema: z.object({
			secrets: z.array(listedSecretSchema),
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			// Same declaring-package stamp as secretSet / secretDelete so an
			// imported provider export lists that package's bucket, not the
			// consumer run's. Stamps outside the host grant set fall back to
			// the run package id.
			const { authorityPackageId, storageContext } =
				resolveCallerSecretAuthority({
					storageContext: ctx.callerContext.storageContext,
				})
			const packageId = authorityPackageId?.trim() || null
			const listScope = await loadSecretListScope(ctx, 'secret:use')
			const listed = await listSecrets({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				scope: args.scope ?? null,
				storageContext,
			})
			const secrets = listed.filter((secret) =>
				listScopeIncludes(listScope, secret.credentialId),
			)
			const implicitReadAccess =
				packageId == null
					? true
					: await packageHasImplicitUserSecretReadAccess({
							env: ctx.env,
							userId: ownerIdFromCaller(ctx.callerContext),
							packageId,
						})
			const accessibleSecrets =
				packageId && !implicitReadAccess
					? secrets.filter(
							(secret) =>
								secret.scope !== 'user' ||
								secret.allowedPackages.includes(packageId),
						)
					: secrets
			return {
				secrets: accessibleSecrets.map((secret) =>
					toListedSecretCapabilityOutput(secret),
				),
			}
		},
	},
)

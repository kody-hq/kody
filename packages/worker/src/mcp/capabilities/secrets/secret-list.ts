import { listScopeIncludes } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { packageHasImplicitUserSecretReadAccess } from '#mcp/secrets/package-access.ts'
import { isAllowedPackagesSafetyWindowActive } from '#worker/credentials/allowed-packages-safety-window.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { loadSecretListScope } from './authorize-secret.ts'
import { listedSecretSchema, toListedSecretCapabilityOutput } from './shared.ts'

export const secretListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretList',
		contextRuns: 'allow',
		orgPermission: 'secret:use',
		description:
			'List available secret references for the signed-in user. Results include metadata such as names, credential ids (for accessGrant), descriptions, allowed hosts, allowed packages, and package_id for package-scoped secrets — never plaintext values. Explicit listing includes caller-owned package-scoped metadata from execute (no package runtime); using a package secret still requires package context. From a package runtime, a package sees the user secrets it can use: every user secret whose allowed-packages list includes it, plus, for self-authored and adopted packages, user secrets with an empty list. A non-empty list that leaves the package out hides that secret, including for packages you authored or adopted. Listing a secret does not approve a host: outbound `fetch` still resolves `{{secret:name}}` (optionally `{{secret:name|scope=user}}`) only for approved hosts. Use `kody.secretList({ scope })` inside execute-time code for the same metadata. Use `/connect/secret-set` for user-provided API key, token, and credential entry or rotation.',
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
			const userId = ownerIdFromCaller(ctx.callerContext)
			const accessibleSecrets = packageId
				? await filterSecretsForPackage({
						env: ctx.env,
						userId,
						packageId,
						secrets,
					})
				: secrets
			return {
				secrets: accessibleSecrets.map((secret) =>
					toListedSecretCapabilityOutput(secret),
				),
			}
		},
	},
)

type ListedSecret = Awaited<ReturnType<typeof listSecrets>>[number]

/** Listing matches `assertPackageCanAccessResolvedSecret` for `use`. */
async function filterSecretsForPackage(input: {
	env: Env
	userId: ReturnType<typeof ownerIdFromCaller>
	packageId: string
	secrets: Array<ListedSecret>
}) {
	const onList = (secret: ListedSecret) =>
		secret.scope !== 'user' || secret.allowedPackages.includes(input.packageId)
	const implicit = await packageHasImplicitUserSecretReadAccess({
		env: input.env,
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!implicit) return input.secrets.filter(onList)
	const locked = (secret: ListedSecret) =>
		!onList(secret) && secret.allowedPackages.length > 0
	if (!input.secrets.some(locked)) return input.secrets
	// Safety window (#4129): nothing is refused while it is open, so locked
	// secrets stay listed.
	if (await isAllowedPackagesSafetyWindowActive({ db: input.env.APP_DB })) {
		return input.secrets
	}
	return input.secrets.filter((secret) => !locked(secret))
}

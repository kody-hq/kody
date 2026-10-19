import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import {
	findSecret,
	readSecretMetadata,
	saveSecret,
	updateSecret,
	updateUserSecretForPackage,
} from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { authorizeSecretSet } from './authorize-secret.ts'
import { assertPackageScopedSecretWriteAvailable } from './package-scoped-secret-write.ts'
import {
	applyCredentialFieldsOnly,
	optInCredentialInputFields,
	planOptInCredentialFields,
	toSaveSecretCredential,
} from './secret-set-opt-in.ts'
import { secretMetadataSchema, toSecretCapabilityOutput } from './shared.ts'

const secretSetInputSchema = z
	.object({
		name: z.string().min(1).describe('Secret name to create or update.'),
		value: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Secret value to persist. Required when creating a secret. Optional on updates that only change description or expires_at. Write-only and must never be returned to the caller.',
			),
		description: z
			.string()
			.optional()
			.describe('Optional human-readable description of the secret.'),
		expires_at: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Optional UTC ISO expiry (or YYYY-MM-DD). Null or empty clears expiry. Omit on update to leave the existing expiry unchanged.',
			),
		scope: z
			.enum(secretScopeValues)
			.describe('Storage scope that owns the secret.'),
		...optInCredentialInputFields,
	})
	.superRefine((value, ctx) => {
		if (
			(typeof value.value !== 'string' || value.value.length === 0) &&
			value.description === undefined &&
			value.expires_at === undefined &&
			value.provider === undefined &&
			value.inject === undefined &&
			value.placement === undefined &&
			value.kind === undefined &&
			value.hosts === undefined &&
			value.login_exchange === undefined
		) {
			ctx.addIssue({
				code: 'custom',
				message:
					'Provide a secret value, or a description / expires_at / provider / inject / placement update for an existing secret.',
				path: ['value'],
			})
		}
	})

export const secretSetCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretSet',
		orgPermission: 'secret:write',
		description:
			'Create or update a stored secret reference for the signed-in user. Use this for API keys, PATs, webhook HMAC secrets, and other static credentials already available inside trusted execution. Do not persist OAuth access or refresh tokens here — `/connect/oauth` and `createAuthenticatedFetch` / `integrationTokenRefresh` write those on the connection. Optional expires_at is a UTC ISO timestamp or YYYY-MM-DD; null clears expiry. Updates that only change description or expiry may omit value. Optional `placement` sets which request parts placeholders may fill (headers, query, path, body; null = anywhere); new credentials default to headers-only. Distinct from `inject` (scoped credential() client). The gateway does not enforce placement yet. Use `/connect/secret-set` for user-provided API key, PAT, and credential entry or rotation. Host use is authorized through secret policy approvals. Saved secrets are consumed in outbound `fetch` calls by placeholder, e.g. `{{secret:name}}`, resolved only for approved hosts.',
		keywords: [
			'secret',
			'persist',
			'store',
			'api key',
			'pat',
			'credential',
			'expires',
			'expiry',
			'placement',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		// Zod (not z.toJSONSchema): wrapper parse_input → McpCallerError (KODY-8T).
		inputSchema: secretSetInputSchema,
		outputSchema: secretMetadataSchema,
		async handler(parsed, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const { authorityPackageId, storageContext } =
				resolveCallerSecretAuthority({
					storageContext: ctx.callerContext.storageContext,
				})
			assertPackageScopedSecretWriteAvailable({
				scope: parsed.scope,
				storageContext,
			})
			await authorizeSecretSet(ctx, {
				name: parsed.name,
				scope: parsed.scope,
				storageContext,
			})
			const optIn = await planOptInCredentialFields(ctx, {
				input: parsed,
				authorityPackageId,
			})
			if (optIn.mode === 'fields-only') {
				const report = await applyCredentialFieldsOnly(ctx, optIn)
				const metadata = await readSecretMetadata({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					scope: parsed.scope,
					name: parsed.name,
					storageContext,
				})
				return { ...toSecretCapabilityOutput(metadata), ...report }
			}
			let saved
			if (parsed.scope === 'user' && authorityPackageId) {
				if (parsed.expires_at !== undefined) {
					throw new McpCallerError(
						'Package runtimes cannot change user secret expiry. Set expires_at from the account page or secretSet outside a package.',
					)
				}
				if (typeof parsed.value !== 'string' || parsed.value.length === 0) {
					throw new McpCallerError(
						'Package runtimes must supply a secret value when updating a user secret.',
					)
				}
				const existing = await findSecret({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					name: parsed.name,
					scope: 'user',
					storageContext,
				})
				if (!existing.found) {
					throw new McpCallerError(
						'Package runtimes cannot create user-scoped secrets. Create the secret from the account page and approve the package first.',
					)
				}
				await assertPackageCanAccessResolvedSecret({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
					userId: ownerIdFromCaller(ctx.callerContext),
					storageContext,
					authorityPackageId,
					secretName: parsed.name,
					resolved: existing,
					intent: 'mutate',
				})
				saved = await updateUserSecretForPackage({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					userEmail: user.email,
					packageId: authorityPackageId,
					name: parsed.name,
					value: parsed.value,
					description: parsed.description,
				})
			} else if (typeof parsed.value === 'string' && parsed.value.length > 0) {
				saved = await saveSecret({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					userEmail: user.email,
					scope: parsed.scope,
					name: parsed.name,
					value: parsed.value,
					description: parsed.description ?? '',
					expiresAt: parsed.expires_at,
					storageContext,
					...(optIn.mode === 'with-value'
						? { credential: toSaveSecretCredential(ctx, optIn) }
						: {}),
				})
			} else {
				saved = await updateSecret({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					scope: parsed.scope,
					name: parsed.name,
					description: parsed.description,
					expiresAt: parsed.expires_at,
					storageContext,
				})
			}
			const output = toSecretCapabilityOutput(saved)
			return optIn.mode === 'with-value'
				? { ...output, ...optIn.report }
				: output
		},
	},
)

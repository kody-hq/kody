import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { parseSecretNameOrPlaceholder } from '#mcp/secrets/placeholders.ts'
import { attestedPackageStampFromCaller } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import {
	jwtAlgorithms,
	jwtKeyEncodings,
	signJwtWithSecret,
} from './jwt-signing.ts'

const jwtAlgorithmSchema = z.enum(jwtAlgorithms)
const jwtKeyEncodingSchema = z.enum(jwtKeyEncodings)

const jwtClaimsSchema = z.record(z.string(), z.unknown())

const jwtSignInputSchema = z.object({
	private_key_secret_name: z
		.string()
		.min(1)
		.describe(
			'Saved signing-key secret name, or an opaque {{secret:…}} ref from packageSecrets.get. PKCS#8 PEM for RS*, PS*, ES*, and EdDSA, or HMAC key material for HS*.',
		),
	private_key_secret_scope: z
		.enum(secretScopeValues)
		.optional()
		.describe(
			'Optional secret scope. When omitted, Kody checks accessible scopes in precedence order.',
		),
	private_key_json_field: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional JSON object field containing the signing key, for example "private_key" for service-account JSON.',
		),
	algorithm: jwtAlgorithmSchema.default('RS256'),
	key_encoding: jwtKeyEncodingSchema
		.optional()
		.describe(
			'HMAC key encoding when algorithm is HS256, HS384, or HS512. Defaults to base64 (DoorDash Drive signing_secret). Not valid for RS*, PS*, ES*, or EdDSA.',
		),
	header: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Optional JWT header fields. "alg" must match the requested algorithm when provided.',
		),
	claims: jwtClaimsSchema.describe('JWT claims to sign.'),
})

export const jwtSignCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretJwtSign',
		contextRuns: 'deny',
		orgPermission: 'secret:use',
		description:
			'Sign a JWT with a key stored in a saved secret without revealing the key. HMAC algorithms (HS256, HS384, HS512) use key material from the secret; RS*, PS*, ES*, and EdDSA use a PKCS#8 PEM private key. This generic primitive only signs caller-provided header and claims; package or execute code should perform any OAuth token exchange separately.',
		keywords: [
			'jwt',
			'sign',
			'signing key',
			'private key',
			'hmac',
			'hs256',
			'rs256',
			'ps256',
			'es256',
			'ecdsa',
			'eddsa',
			'ed25519',
			'service account',
			'oauth',
			'doordash',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jwtSignInputSchema,
		outputSchema: z.object({
			jwt: z.string(),
			algorithm: jwtAlgorithmSchema,
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const { packageStamp, storageContext } = attestedPackageStampFromCaller({
				storageContext: ctx.callerContext.storageContext,
			})
			const referenced = parseSecretNameOrPlaceholder(
				args.private_key_secret_name,
				'private_key_secret_name',
			)
			const secretName = referenced.name
			const secretScope =
				args.private_key_secret_scope ?? referenced.scope ?? undefined
			const secretUserId = ownerIdFromCaller(ctx.callerContext)
			const resolved = await resolveCredential({
				env: ctx.env,
				orgId: secretUserId,
				actor: ctx.callerContext.request,
				packageStamp,
				baseUrl: ctx.callerContext.baseUrl,
				credential: {
					use: 'secret',
					name: secretName,
					scope: secretScope,
					storageContext,
					orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
				},
			})
			if (!resolved.found || typeof resolved.value !== 'string') {
				// Missing or scope-unavailable secrets are caller-clearable
				// (wrong name/runtime). Keep them off Sentry via McpCallerError.
				throw new McpCallerError(
					await createUnresolvedSecretMessage({
						env: ctx.env,
						userId: secretUserId,
						name: secretName,
						scope: secretScope,
						storageContext,
						baseUrl: ctx.callerContext.baseUrl,
					}),
				)
			}

			return {
				jwt: await signJwtWithSecret(resolved.value, {
					algorithm: args.algorithm,
					keyEncoding: args.key_encoding,
					jsonField: args.private_key_json_field,
					header: args.header,
					claims: args.claims,
				}),
				algorithm: args.algorithm,
			}
		},
	},
)

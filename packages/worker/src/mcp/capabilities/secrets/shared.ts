import { z } from 'zod'
import {
	credentialFillPlacementSchema,
	credentialInjectSchema,
} from '#worker/credentials/credential-fields.ts'
import {
	type ListedSecret,
	type SecretMetadata,
	secretScopeValues,
} from '#mcp/secrets/types.ts'

export const secretMetadataSchema = z.object({
	name: z.string(),
	scope: z.enum(secretScopeValues),
	description: z.string(),
	package_id: z.string().nullable(),
	allowed_hosts: z.array(z.string()),
	allowed_packages: z.array(z.string()),
	created_at: z.string(),
	updated_at: z.string(),
	expires_at: z.string().nullable(),
	ttl_ms: z.number().int().nonnegative().nullable(),
	kind: z
		.enum(['secret', 'url', 'login', 'signing'])
		.optional()
		.describe('Credential kind, returned when this call set opt-in fields.'),
	provider: z.string().nullable().optional(),
	inject: credentialInjectSchema.optional(),
	placement: credentialFillPlacementSchema
		.nullable()
		.optional()
		.describe(
			'Where placeholders may be filled. Null means anywhere. Returned when this call set opt-in fields.',
		),
})

export function toSecretCapabilityOutput(secret: SecretMetadata) {
	return {
		name: secret.name,
		scope: secret.scope,
		description: secret.description,
		package_id: secret.packageId,
		allowed_hosts: secret.allowedHosts,
		allowed_packages: secret.allowedPackages,
		created_at: secret.createdAt,
		updated_at: secret.updatedAt,
		expires_at: secret.expiresAt,
		ttl_ms: secret.ttlMs,
	}
}

export const listedSecretSchema = secretMetadataSchema.extend({
	credential_id: z
		.string()
		.describe('Stable credential id. accessGrant uses it as resource_id.'),
})

export function toListedSecretCapabilityOutput(secret: ListedSecret) {
	return {
		credential_id: secret.credentialId,
		...toSecretCapabilityOutput(secret),
	}
}

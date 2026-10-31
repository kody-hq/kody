import { z } from 'zod'
import {
	credentialFillPlacementSchema,
	credentialInjectSchema,
} from '#worker/credentials/credential-fields.ts'
import { credentialPlacementOrigins } from '#worker/credentials/placement-origin.ts'
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
		.describe(
			'Where placeholders may be filled: headers (optionally named), query, path, and/or body. Null means not set (legacy): the gateway fills headers plus the parts it was seen used in before enforcement. New credentials default to headers-only. Distinct from inject. The gateway enforces it: query, path, and body also need an owner opt-in on the credential page, because the host may store the value.',
		),
	placement_origin: z
		.enum(credentialPlacementOrigins)
		.nullable()
		.describe(
			'How fill placement was chosen: manifest (package declaration), default_unread (manifest could not be read), default_undeclared (package has no placement on this need), owner (credential page editor), explicit (secretSet / credentialUpdate placement input). Null on legacy rows. Query, path, and body take effect only after the owner opts in on the credential page.',
		),
	disconnected: z
		.boolean()
		.describe(
			'True when Disconnect cleared the value but kept the credential row (placement, hosts, grants). Reconnect with secretSet to restore the value. Distinct from Delete, which removes the row.',
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
		placement: secret.placement,
		placement_origin: secret.placementOrigin ?? null,
		disconnected: secret.disconnected,
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

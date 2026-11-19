import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { decryptSecretValue, encryptSecretValue } from '#mcp/secrets/crypto.ts'
import { assertPlaceholderSecretName } from '#mcp/secrets/secret-name-references.ts'
import { tryCanonicalizeProviderRef } from '#mcp/secrets/secret-providers/canonicalize.ts'
import { providerHostsAllowRequestHost } from '#mcp/secrets/secret-providers/hosts.ts'
import {
	listSecretProviderBindings,
	getSecretProviderBinding,
} from '#mcp/secrets/secret-providers/repo.ts'
import { invokeSealedSecretProvider } from '#mcp/secrets/secret-providers/sealed-invoke.ts'
import { resolveProviderSecret } from '#mcp/secrets/secret-providers/service.ts'
import { saveSecret, type StoredCredential } from '#mcp/secrets/service.ts'
import {
	readVaultItemConfig,
	vaultItemRefContext,
} from '#mcp/secrets/vault-item-config.ts'
import type { OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import {
	credentialHostsSchema,
	credentialProviderSchema,
	defaultCredentialInject,
} from './credential-fields.ts'
import {
	defaultNewCredentialFillPlacement,
	serializeCredentialFillPlacement,
} from './fill-placement.ts'
import {
	authorizeActorUse,
	type ResolverCall,
	type CredentialTargetFor,
} from './credential-resolver.ts'
import { CredentialRequestRefusedError } from './credential-request.ts'

export async function createVaultItemCredential(input: {
	env: Env
	ownerId: OwnerId
	bindingId: string
	itemId: string
	field: string
	name: string
	hosts: Array<string>
	provider?: string
	audit: OrgAuditWriter
}) {
	const binding = (
		await listSecretProviderBindings(input.env.APP_DB, {
			userId: input.ownerId,
		})
	).find(({ credentialId }) => credentialId === input.bindingId)
	if (!binding)
		throw new McpCallerError('Select an available provider binding.')
	const name = input.name.trim()
	assertPlaceholderSecretName(name)
	const ref = tryCanonicalizeProviderRef(
		`i/${input.itemId.trim()}/${input.field.trim()}`,
	)
	if (!ref || ref.length > 512 || input.itemId.includes('/')) {
		throw new McpCallerError('Use a canonical vault item ID and field.')
	}
	const hosts = credentialHostsSchema.safeParse(input.hosts)
	const provider = credentialProviderSchema.optional().safeParse(input.provider)
	if (!hosts.success || hosts.data.length === 0 || !provider.success) {
		throw new McpCallerError(
			'Provide approved hosts and an optional provider slug.',
		)
	}
	const config = {
		kind: 'vault-item',
		bindingId: binding.credentialId,
		providerId: binding.providerId,
		encryptedRef: await encryptSecretValue(
			input.env,
			ref,
			vaultItemRefContext(input.ownerId, binding.credentialId),
		),
	}
	await saveSecret({
		env: input.env,
		userId: input.ownerId,
		scope: 'user',
		name,
		// A distinct encrypted marker keeps the ordinary Key lifecycle and
		// never contains the provider reference or any provider material.
		value: crypto.randomUUID(),
		createOnly: true,
		audit: null,
		credential: {
			kind: 'secret',
			allowedHosts: hosts.data,
			configJson: JSON.stringify(config),
			provider: provider.data ?? null,
			injectJson: JSON.stringify(defaultCredentialInject),
			placementJson: serializeCredentialFillPlacement(
				defaultNewCredentialFillPlacement,
			),
			audit: {
				writer: input.audit,
				event: (id) => ({
					orgId: input.ownerId,
					action: 'credential.vault_item_created',
					resourceType: 'credential',
					resourceId: id,
				}),
			},
		},
	})
}

export async function prepareVaultItemRead(
	call: ResolverCall<CredentialTargetFor<'client-key'>>,
	found: StoredCredential,
	readStoredValue: () => Promise<string>,
): Promise<() => Promise<string>> {
	const config = readVaultItemConfig(found.configJson)
	if (!config) return readStoredValue
	const { input, credential } = call
	const request = input.actor
	const packageId = credential.attestedPackageId
	const refused = () =>
		new CredentialRequestRefusedError(
			'invalid_request',
			'This vault-backed Key requires an approved package, provider item grant, and matching website.',
		)
	if (!request || !packageId || found.ownerId !== input.orgId) throw refused()
	const binding = await getSecretProviderBinding(input.env.APP_DB, {
		userId: found.ownerId,
		providerId: config.providerId,
	})
	if (!binding || binding.credentialId !== config.bindingId) throw refused()
	await authorizeActorUse(
		{ ...call, subject: { ...call.subject } },
		binding.credentialId,
		config.providerId,
	)
	return async () => {
		try {
			const ref = await decryptSecretValue(
				input.env,
				config.encryptedRef,
				vaultItemRefContext(found.ownerId, config.bindingId),
			)
			const resolved = await resolveProviderSecret({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: found.ownerId,
				request,
				provider: config.providerId,
				binding,
				ref,
				storageContext: null,
				authorityPackageId: packageId,
				invokeProvider: invokeSealedSecretProvider,
			})
			if (
				!providerHostsAllowRequestHost(
					resolved.hosts,
					credential.requestUrl.hostname,
				)
			)
				throw refused()
			return resolved.value
		} catch {
			// Provider diagnostics can include the private item/field reference.
			throw refused()
		}
	}
}

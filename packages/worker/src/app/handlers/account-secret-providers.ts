import type { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	bindSecretProvider,
	grantSecretProviderToPackage,
	revokeSecretProviderGrant,
	unbindSecretProvider,
} from '#mcp/secrets/secret-providers/service.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { createVaultItemCredential } from '#worker/credentials/vault-item-credential.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function createAccountVaultItemCredential(input: {
	env: Env
	user: AuthenticatedUser
	bindingId: string
	itemId: string
	field: string
	name: string
	hosts: Array<string>
	provider?: string
}) {
	await authorizeOrgWide(
		{ env: input.env, request: input.user.request },
		'secret:write',
	)
	await createVaultItemCredential({
		...input,
		ownerId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({ ok: true })
}

export async function bindAccountSecretProvider(input: {
	env: Env
	user: AuthenticatedUser
	provider: string
	packageId: string
	doorCredentialId?: string
	doorSecretName?: string
	config: Record<string, string>
	requestUrl: string
}) {
	const bound = await bindSecretProvider({
		env: input.env,
		baseUrl: new URL(input.requestUrl).origin,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		providerId: input.provider.trim(),
		packageId: input.packageId.trim(),
		doorCredentialId: input.doorCredentialId,
		doorSecretName: input.doorSecretName,
		config: input.config,
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({ ok: true, bound })
}

export async function unbindAccountSecretProvider(input: {
	env: Env
	user: AuthenticatedUser
	provider: string
}) {
	await unbindSecretProvider({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		providerId: input.provider.trim(),
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({ ok: true })
}

export async function grantAccountSecretProvider(input: {
	env: Env
	user: AuthenticatedUser
	provider: string
	ref: string
	packageId: string
}) {
	const granted = await grantSecretProviderToPackage({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		providerId: input.provider.trim(),
		ref: input.ref.trim(),
		packageId: input.packageId.trim(),
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({ ok: true, granted })
}

export async function revokeAccountSecretProvider(input: {
	env: Env
	user: AuthenticatedUser
	provider: string
	ref: string
	packageId: string
}) {
	await revokeSecretProviderGrant({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		providerId: input.provider.trim(),
		ref: input.ref.trim(),
		packageId: input.packageId.trim(),
		audit: orgAuditWriterFromRequest(input.env, input.user.request),
	})
	return operationResult({ ok: true })
}

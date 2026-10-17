import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	bindSecretProvider,
	grantSecretProviderToPackage,
	revokeSecretProviderGrant,
	unbindSecretProvider,
} from '#mcp/secrets/secret-providers/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function bindAccountSecretProvider(input: {
	env: Env
	user: AuthenticatedUser
	provider: string
	packageId: string
	doorSecretName: string
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
		doorSecretName: input.doorSecretName.trim(),
		config: input.config,
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
	})
	return operationResult({ ok: true })
}

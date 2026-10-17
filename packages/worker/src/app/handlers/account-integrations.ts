import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { toOauthAppPublic } from '#mcp/capabilities/integrations/oauth-app-shared.ts'
import { persistUserOauthAppClientSecret } from '#worker/integrations/credentials.ts'
import {
	deleteIntegration,
	deleteOauthAppWithConnections,
	getOauthApp,
	grantIntegrationPackage,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
	setIntegrationUsage,
} from '#worker/integrations/service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type z } from 'zod'
import {
	type rotateOauthAppCredentialsSchema,
	type setUsageSchema,
	type approvePackageSchema,
} from '#universal/integration-mutations.ts'

export async function setAccountIntegrationUsage(
	input: {
		env: Env
		user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	} & z.infer<typeof setUsageSchema>,
) {
	const allowedPackageIds =
		input.usageMode === 'packages' ? (input.allowedPackageIds ?? []) : []
	const updated = await setIntegrationUsage({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		name: input.name,
		usageMode: input.usageMode,
		allowedPackageIds,
	})
	if (!updated) {
		return operationResult({ ok: false, error: 'Connection not found.' }, 404)
	}
	return operationResult({
		ok: true,
		usageMode: updated.usageMode,
		allowedPackageIds: updated.allowedPackageIds,
	})
}

export async function approveAccountIntegrationPackage(
	input: {
		env: Env
		user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	} & z.infer<typeof approvePackageSchema>,
) {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const savedPackage = (
		await listSavedPackagesByUserId(input.env.APP_DB, {
			userId,
		})
	).find((entry) => entry.id === input.packageId)
	if (!savedPackage) {
		return operationResult(
			{ ok: false, error: 'That package is not on this account.' },
			400,
		)
	}
	const updated = await grantIntegrationPackage({
		env: input.env,
		userId,
		name: input.name,
		packageId: input.packageId,
	})
	if (!updated) {
		return operationResult({ ok: false, error: 'Connection not found.' }, 404)
	}
	return operationResult({
		ok: true,
		alreadyGranted:
			updated.usageMode === 'any' ||
			updated.allowedPackageIds.includes(input.packageId),
		usageMode: updated.usageMode,
		allowedPackageIds: updated.allowedPackageIds,
	})
}

export async function disconnectAccountIntegration(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	name: string
}) {
	const deleted = await deleteIntegration({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		name: input.name,
	})
	if (!deleted) {
		return operationResult({ ok: false, error: 'Connection not found.' }, 404)
	}
	return operationResult({ ok: true, deleted: true })
}

export async function deleteAccountOauthApp(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	appSlug: string
}) {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const existing = await getOauthApp({
		env: input.env,
		userId,
		slug: input.appSlug,
	})
	if (!existing) {
		return operationResult({ ok: false, error: 'OAuth app not found.' }, 404)
	}
	const result = await deleteOauthAppWithConnections({
		env: input.env,
		userId,
		slug: existing.slug,
	})
	if (!result.deleted) {
		return operationResult({ ok: false, error: 'OAuth app not found.' }, 404)
	}
	return operationResult({
		ok: true,
		deleted: true,
		connectionNames: result.connectionNames,
	})
}

export async function rotateAccountOauthAppCredentials(
	input: {
		env: Env
		user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	} & z.infer<typeof rotateOauthAppCredentialsSchema>,
) {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const existing = await getOauthApp({
		env: input.env,
		userId,
		slug: input.appSlug,
	})
	if (!existing) {
		return operationResult({ ok: false, error: 'OAuth app not found.' }, 404)
	}

	const nextClientId = input.clientId?.trim() || existing.clientId

	try {
		if (input.clientSecret) {
			await persistUserOauthAppClientSecret({
				env: input.env,
				userId,
				slug: existing.slug,
				value: input.clientSecret,
			})
		}

		const rotated = await rotateOauthAppClientCredentials({
			env: input.env,
			userId,
			slug: existing.slug,
			clientId: nextClientId,
		})
		const joined = await listJoinedIntegrations({
			env: input.env,
			userId,
		})
		const connections = joined
			.filter((entry) => entry.app.slug === rotated.slug)
			.map(({ connection }) => ({
				name: connection.name,
				accountLabel: connection.accountLabel,
			}))
		return operationResult({
			ok: true,
			app: toOauthAppPublic(
				{ ...rotated, connectionCount: connections.length },
				connections,
			),
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to rotate OAuth app credentials.',
			},
			400,
		)
	}
}

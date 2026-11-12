import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { loadLiveOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	fileEffectivePermissions,
	fileCollaborationEnabled,
} from './feature.ts'
import { checkPermission } from '#worker/authorization/authorize.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import { fileStoreRpc } from './client.ts'
import type { FileStorageConfig } from '#universal/file-storage.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { storageEndpoint } from './object-storage.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
async function scope(ctx: CapabilityContext) {
	const request = requireMcpRequest(ctx.callerContext)
	if (!request.actor) throw new McpCallerError('Sign in to manage storage.')
	const binding = await loadLiveOrgBindingForOrg(
		ctx.env.APP_DB,
		request.actor.userId,
		request.org.id,
	)
	const fresh = {
		...request,
		membership: binding?.role ? { role: binding.role } : null,
	}
	const access = await fileEffectivePermissions(ctx.env, fresh)
	if (
		binding?.role !== 'owner' ||
		!checkPermission(access, 'file:manage_access').allowed ||
		!(await fileCollaborationEnabled(ctx.env, fresh))
	)
		throw new McpCallerError('Only a workspace owner can manage file storage.')
	return {
		request: fresh,
		access,
		store: fileStoreRpc(ctx.env, request.org.id),
	}
}
async function storageCredentials(
	env: Env,
	s: Awaited<ReturnType<typeof scope>>,
) {
	return (
		await listSecrets({
			env,
			userId: s.request.org.id,
			scope: 'user',
		})
	).filter(
		(secret) =>
			secret.credentialId &&
			!secret.disconnected &&
			(!secret.expiresAt || Date.parse(secret.expiresAt) > Date.now()) &&
			!secret.allowedPackages.length &&
			checkPermission(s.access, 'secret:use', {
				type: 'credential',
				id: secret.credentialId,
				orgId: s.request.org.id,
				label: secret.name,
			}).allowed,
	)
}

export async function listFileStorageCredentialNames(ctx: CapabilityContext) {
	const names = (await storageCredentials(ctx.env, await scope(ctx))).map(
		(secret) => secret.name,
	)
	return names.sort((a, b) => a.localeCompare(b))
}

export async function getFileStorage(ctx: CapabilityContext) {
	const s = await scope(ctx)
	return s.store.storageStatus(s.request.org.id)
}
export async function configureFileStorage(
	ctx: CapabilityContext,
	configuration: FileStorageConfig | null,
) {
	const s = await scope(ctx)
	let config: FileStorageConfig | null = null
	if (configuration) {
		storageEndpoint(configuration.endpoint)
		const found = (await storageCredentials(ctx.env, s)).find(
			(secret) => secret.name === configuration.credentialName,
		)
		if (!found?.credentialId)
			throw new McpCallerError(
				'Use a dedicated workspace credential that you can use, without a package restriction.',
			)
		config = {
			...configuration,
			credentialId: found.credentialId,
			authorizedBy: s.request.actor!.userId,
		}
	}
	return withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: s.request.org.id,
		holder: 'file-storage-settings',
		write: () => s.store.configureStorage(s.request.org.id, config),
	})
}

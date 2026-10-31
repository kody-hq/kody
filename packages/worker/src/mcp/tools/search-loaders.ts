import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { filterCapabilityRegistryMcpServersForCaller } from '#mcp/capabilities/access-control.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { listJoinedIntegrations } from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import {
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
	resourceVisibility,
	runWithRequestPermissions,
} from '#worker/authorization/authorize.ts'

import { buildSavedPackageSearchRows } from './search-package-rows.ts'
import {
	type LoadedPackageRows,
	type OptionalSearchRowsResult,
} from './search-types.ts'

export async function loadOptionalSearchRows(input: {
	userId: OwnerId | null
	loadPackages: () => Promise<LoadedPackageRows>
	loadUserSecrets: () => Promise<Array<SecretSearchRow>>
	loadUserIntegrations: () => Promise<Array<JoinedIntegration>>
}): Promise<OptionalSearchRowsResult> {
	if (!input.userId) {
		return {
			packageRows: [],
			userSecretRows: [],
			userIntegrationRows: [],
			warnings: [],
		}
	}

	const [loadedPackageRows, userSecretRows, userIntegrationRows] =
		await Promise.all([
			input.loadPackages(),
			input.loadUserSecrets(),
			input.loadUserIntegrations(),
		])
	const packageRows = Array.isArray(loadedPackageRows)
		? loadedPackageRows
		: loadedPackageRows.rows

	return {
		packageRows,
		userSecretRows,
		userIntegrationRows,
		warnings: [],
	}
}

export async function loadSearchRowsAndRegistry(input: {
	env: Env
	callerContext: McpCallerContext
	userId: OwnerId | null
	includeHiddenPackages?: boolean
}) {
	const { request } = input.callerContext
	const access = request
		? await computeEffectivePermissions({ env: input.env, request })
		: null
	const reveal = (pkg: { id: string; userId: OwnerId }) =>
		!access || canSeeResource(access, packageResource(pkg))
	const revealSecret = access
		? resourceVisibility(access, 'credential', ['secret:use', 'secret:write'])
		: () => true
	const revealIntegration = access
		? resourceVisibility(access, 'credential', [
				'integration:use',
				'integration:read',
				'integration:write',
			])
		: () => true
	return await runWithRequestPermissions(
		{ env: input.env, request },
		async () => {
			const [runtimeRegistry, optionalRows] = await Promise.all([
				getCapabilityRegistryForContext({
					env: input.env,
					callerContext: input.callerContext,
				}),
				loadOptionalSearchRows({
					userId: input.userId,
					loadPackages: async () => {
						if (!input.userId) {
							return { rows: [], warnings: [] }
						}
						// Packages are keyed by the bound org, not the acting person.
						const ownerId = request?.org.id ?? input.userId
						const savedPackages = await applySavedPackageForkListingAncestry({
							env: input.env,
							records: await listSavedPackagesWithCommunityProvenanceByUserId(
								input.env.APP_DB,
								{ userId: ownerId },
							),
						})
						return await buildSavedPackageSearchRows({
							env: input.env,
							baseUrl: input.callerContext.baseUrl,
							userId: ownerId,
							records: savedPackages.filter(
								(pkg) =>
									(input.includeHiddenPackages ? true : !pkg.hidden) &&
									reveal(pkg),
							),
						})
					},
					loadUserSecrets: async () => {
						const userId = input.userId
						if (!userId) return []
						const secrets = await listUserSecretsForSearch({
							env: input.env,
							userId,
						})
						return secrets.filter((secret) => revealSecret(secret.credentialId))
					},
					loadUserIntegrations: async () => {
						const userId = input.userId
						if (!userId) return []
						const integrations = await listJoinedIntegrations({
							env: input.env,
							userId,
						})
						return integrations.filter((entry) =>
							revealIntegration(entry.connection.credentialId),
						)
					},
				}),
			])
			// Runtime registry keeps package-locked MCP servers for call-time grants;
			// search must still hide servers the caller cannot use (execute / other pkgs).
			const registry = input.userId
				? filterCapabilityRegistryMcpServersForCaller(
						runtimeRegistry,
						new Set(
							(
								await listVisibleEnabledMcpServerRefsCached({
									env: input.env,
									userId: input.userId,
									packageId: input.callerContext.storageContext?.packageId,
								}).catch(() => [])
							)
								.filter((ref) => revealIntegration(ref.serverId))
								.map((ref) => ref.serverId),
						),
					)
				: runtimeRegistry
			return {
				registry,
				...optionalRows,
			}
		},
	)
}

import { parseCredentialCreateQuery } from '#universal/credential-contracts.ts'
import {
	buildAccountSecretId,
	type AccountSecretRouteIdInput,
} from '@kody-internal/shared/account-secret-route.ts'
export function secretsInput(
	orgSlug: string,
	search: string,
	selection?: AccountSecretRouteIdInput,
	create = false,
) {
	const params = new URLSearchParams(search)
	const scope = params.get('scope')?.trim()
	const creationParams = new URLSearchParams(params)
	for (const value of params.getAll('allowed-host'))
		creationParams.append('allowedHosts', value)
	for (const key of ['package', 'package_id']) {
		for (const value of params.getAll(key))
			creationParams.append('allowedPackages', value)
	}
	const creation = parseCredentialCreateQuery(creationParams)
	return {
		orgSlug,
		create,
		creation: {
			name: creation.name,
			provider: creation.provider,
			description: creation.description,
			allowedHosts: creation.allowedHosts,
			packageKodyId: creation.packageKodyId,
			needKey: creation.needKey,
			packageScopedTo: creation.packageScopedTo,
			packageScopeMissingId: creation.packageScopeMissingId,
			expiresAt: creation.expiresAt,
			allowedPackages: creation.allowedPackages,
		},
		selectedSecretId: selection
			? buildAccountSecretId(selection)
			: params.get('selected')?.trim() || null,
		approval: {
			hosts: [
				...params.getAll('hosts'),
				...params.getAll('host'),
				...params.getAll('allowed-host'),
				...params.getAll('allowedHosts'),
			],
			names: [...params.getAll('names'), ...params.getAll('name')],
			packageId: params.get('package_id') ?? undefined,
			scope:
				scope === 'session'
					? ('session' as const)
					: scope === 'package'
						? ('package' as const)
						: ('user' as const),
			storagePackageId: params.get('packageId') ?? undefined,
			sessionId: params.get('sessionId') ?? undefined,
		},
	}
}

/**
 * Decide fill placement for a package-scope secret insert or repair-on-update.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type CredentialFillPlacement,
	defaultNewCredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import { readDeclaredPackageSecretFillPlacement } from '#worker/credentials/package-manifest-fill-placement.ts'
import {
	type CredentialPlacementOrigin,
	placementOriginAllowsManifestRepair,
} from '#worker/credentials/placement-origin.ts'

export function placementsEqual(
	left: CredentialFillPlacement | null,
	right: CredentialFillPlacement | null,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

export function isUntouchedDefaultPlacement(
	placement: CredentialFillPlacement | null,
	origin: CredentialPlacementOrigin | null,
): boolean {
	return (
		placementOriginAllowsManifestRepair(origin) &&
		placementsEqual(placement, defaultNewCredentialFillPlacement)
	)
}

export type ResolvedPackageSecretPlacement = {
	placement: CredentialFillPlacement
	origin: CredentialPlacementOrigin
	declarationStatus: 'applied' | 'undeclared' | 'unread'
	unreadReason?: string
}

export async function resolvePackageSecretPlacement(input: {
	env: Env
	userId: OwnerId
	baseUrl: string
	packageId: string
	secretName: string
}): Promise<ResolvedPackageSecretPlacement> {
	const declared = await readDeclaredPackageSecretFillPlacement(input)
	switch (declared.status) {
		case 'applied':
			return {
				placement: declared.placement,
				origin: 'manifest',
				declarationStatus: 'applied',
			}
		case 'undeclared':
			return {
				placement: defaultNewCredentialFillPlacement,
				origin: 'default_undeclared',
				declarationStatus: 'undeclared',
			}
		case 'unread':
			return {
				placement: defaultNewCredentialFillPlacement,
				origin: 'default_unread',
				declarationStatus: 'unread',
				unreadReason: declared.reason,
			}
		default: {
			const exhaustive: never = declared
			throw new Error(
				`Unhandled declared placement status: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Whether a credential fits a package's declared need, and loading those
 * needs. Shared by `credential()` and the run gate's mapping pause; kept out
 * of `credential-client.ts` so the run gate does not load secret resolvers.
 */
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	isFetchCapableCredentialKind,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'
import { type UsableCredential } from './credential-candidates.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import {
	savedCredentialNeeds,
	type SavedCredentialNeed,
} from './credential-needs.ts'

/** What a need key asks for: the declared need, or the key read as a provider. */
export type NeedTarget = {
	kind: PackageCredentialKind | null
	provider: string
	describe: string
	/**
	 * How an explicit pick's kind is checked: declared kind, any fetch-capable
	 * kind when the need omits kind, or any kind for an ad-hoc provider key.
	 */
	match: 'exact' | 'fetch-capable' | 'any'
}

/**
 * The credential needs `packageId`'s published source declares that a saved
 * credential fills (secret-provider needs are left out).
 */
export async function loadPackageNeeds(input: {
	env: Env
	/** The org that owns the package. */
	orgId: string
	packageId: string
	request?: object | null
}) {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.orgId,
		packageId: input.packageId,
	})
	if (!saved) return []
	return savedCredentialNeeds(
		await loadPublishedCredentialNeeds({
			env: input.env,
			userId: saved.userId,
			sourceId: saved.sourceId,
			request: input.request,
		}),
	)
}

export function needTarget(
	key: string,
	need: SavedCredentialNeed | null,
): NeedTarget {
	if (!need) {
		return {
			kind: null,
			provider: key,
			describe: `provider "${key}"`,
			match: 'any',
		}
	}
	const provider = need.provider
	if (need.kind) {
		return {
			kind: need.kind,
			provider,
			describe: `need "${key}" (${need.kind} from provider "${provider}")`,
			match: 'exact',
		}
	}
	return {
		kind: null,
		provider,
		describe: `need "${key}" (any fetch-capable credential from provider "${provider}")`,
		match: 'fetch-capable',
	}
}

/**
 * A stored mapping follows the explicit-pick rule: the kind filter must match,
 * and so must the provider when the credential has one. A need whose kind or
 * provider changed after mapping no longer takes the old credential.
 */
export function mappedCredentialFits(
	credential: UsableCredential,
	target: NeedTarget,
): boolean {
	if (credential.provider && credential.provider !== target.provider) {
		return false
	}
	switch (target.match) {
		case 'exact':
			return target.kind === null || credential.kind === target.kind
		case 'fetch-capable':
			return isFetchCapableCredentialKind(credential.kind)
		case 'any':
			return true
		default: {
			const exhaustive: never = target.match
			throw new Error(`Unhandled need match: ${String(exhaustive)}`)
		}
	}
}

/** Whether a mapped `credential` still fits declared `need`, as a run checks it. */
export function mappedCredentialFitsNeed(
	credential: UsableCredential,
	need: SavedCredentialNeed,
): boolean {
	return mappedCredentialFits(credential, needTarget(need.key, need))
}

import {
	grantedSecretAuthorityPackageIdSet,
	resolveCallerSecretAuthority,
} from '#mcp/secrets/secret-authority.ts'
import type { StorageContext } from '#mcp/storage.ts'

/**
 * Which package, if any, is asking `resolveCredential` for a credential.
 *
 * - `attested`: the server knows the package (hosted bundler provenance,
 *   jobs, webhooks, package apps). Package rules are the grant, so the actor
 *   does not also need per-credential Use.
 * - `claimed`: the client named the package (CLI `--local` through the
 *   CapabilityProxy). The id still binds package-scoped buckets and package
 *   rules, but it never skips the actor's Use.
 *
 * No stamp means ad-hoc code: the actor needs Use on each credential.
 */
export type PackageStamp =
	| { kind: 'attested'; packageId: string }
	| { kind: 'claimed'; packageId: string }

export function attestedPackageStamp(
	packageId: string | null | undefined,
): PackageStamp | null {
	const id = packageId?.trim()
	return id ? { kind: 'attested', packageId: id } : null
}

export function claimedPackageStamp(
	packageId: string | null | undefined,
): PackageStamp | null {
	const id = packageId?.trim()
	return id ? { kind: 'claimed', packageId: id } : null
}

/**
 * The stamp for a host capability call. A capability only sees a package id
 * the host installed: the run's `storageContext.packageId` or the bundler
 * secret-authority scope (checked against the run's grant set). A client
 * cannot put either there, so the stamp is attested.
 */
export function attestedPackageStampFromCaller(input: {
	storageContext?: Partial<StorageContext> | null
}): { packageStamp: PackageStamp | null; storageContext: StorageContext } {
	const { authorityPackageId, storageContext } = resolveCallerSecretAuthority({
		storageContext: input.storageContext,
	})
	return {
		packageStamp: attestedPackageStamp(authorityPackageId),
		storageContext,
	}
}

/**
 * Which package is fetching. A CapabilityProxy claim is `claimed`. Otherwise
 * the host-set per-package binding (`boundPackageId`), or else the host-set
 * run package, is `attested`. Request headers never select the package
 * (GHSA-5fv3): sandbox code can set, read, and replay any header.
 */
export function resolveGatewayPackageStamp(props: {
	claimedPackageId?: string | null
	boundPackageId?: string | null
	grantedSecretAuthorityPackageIds?: ReadonlyArray<string>
	storageContext: { packageId?: string | null } | null
}): PackageStamp | null {
	const claimed = claimedPackageStamp(props.claimedPackageId)
	if (claimed) {
		if (props.storageContext?.packageId || props.boundPackageId) {
			throw new Error(
				'Fetch gateway props cannot carry both a claimed package id and a run or bound package id.',
			)
		}
		return claimed
	}
	const bound = props.boundPackageId?.trim() || null
	if (bound) {
		const grantedPackageIds = grantedSecretAuthorityPackageIdSet(
			props.grantedSecretAuthorityPackageIds,
		)
		if (!grantedPackageIds?.has(bound)) {
			throw new Error(
				'Fetch gateway bound package id is not in the run grant set.',
			)
		}
		return attestedPackageStamp(bound)
	}
	return attestedPackageStamp(props.storageContext?.packageId?.trim() || null)
}

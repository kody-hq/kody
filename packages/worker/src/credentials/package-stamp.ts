import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
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

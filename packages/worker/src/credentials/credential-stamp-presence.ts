/**
 * Whether a package's current publish stored a credential stamp (issue #3836
 * phase 3). Presence is the per-package switch for fail-closed credential
 * checks. No stamp, a missing KV binding, or a missing publish keeps the
 * legacy credential path. A stored blob that is not a valid stamp fail-closes.
 */
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import {
	hasPublishedRuntimeArtifacts,
	readPublishedCredentialStamp,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
/**
 * Missing stamp stays on the legacy path. Any stored blob, including one
 * `isStoredCredentialStamp` rejects, fail-closes so a malformed publish cannot
 * restore undeclared credential access.
 */
export function storedCredentialStampEnforces(stored: unknown): boolean {
	return stored != null
}

const presenceByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<boolean>>
>()

async function readPackageCarriesCredentialStamp(input: {
	env: Env
	orgId: string
	packageId: string
}): Promise<boolean> {
	if (!hasPublishedRuntimeArtifacts(input.env)) return false
	// The acting org is not the package owner for an imported dependency.
	// Stamp presence is a fact about the package, like its manifest.
	const saved = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	if (!saved) return false
	const source = await getEntitySourceById(input.env.APP_DB, saved.sourceId)
	const publishedCommit = source?.published_commit
	if (!publishedCommit || source.user_id !== saved.userId) return false
	const stored = await readPublishedCredentialStamp({
		env: input.env,
		sourceId: saved.sourceId,
		publishedCommit,
	})
	return storedCredentialStampEnforces(stored)
}

/**
 * True when this package's published commit has a sealed credential stamp.
 * Cached for the request. Unstamped packages stay on the legacy path.
 */
export async function packageCarriesCredentialStamp(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string
}): Promise<boolean> {
	const load = () => readPackageCarriesCredentialStamp(input)
	if (!input.request) return load()
	let byPackage = presenceByRequest.get(input.request)
	if (!byPackage) {
		byPackage = new Map()
		presenceByRequest.set(input.request, byPackage)
	}
	const cacheKey = `${input.orgId}\n${input.packageId}`
	let pending = byPackage.get(cacheKey)
	if (!pending) {
		pending = load()
		byPackage.set(cacheKey, pending)
		pending.catch(() => byPackage.delete(cacheKey))
	}
	return pending
}

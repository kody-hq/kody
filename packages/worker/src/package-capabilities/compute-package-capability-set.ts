import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import {
	listOrgReachableCredentials,
	liveUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from '#worker/credentials/credential-candidates.ts'
import { loadAllCredentialMappingsForPackage } from '#worker/credentials/credential-mappings.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import {
	ownCredentialNeeds,
	type CredentialNeed,
} from '#worker/credentials/credential-needs.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'
import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { listPublishedBundleArtifactsBySourceId } from '#worker/repo/published-bundle-artifacts-repo.ts'
import { type BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	buildCapabilitySet,
	type CapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'
import {
	canonicalizeDependencySnapshot,
	emptyDependencySnapshot,
	type PackageDependencySnapshot,
} from './dependency-snapshot.ts'
import { publishedPackageUsesStorage } from './package-storage-use.ts'

/**
 * Closure needs win for keys they already list, except `ownerCredentialForVisitors`:
 * the live published manifest may turn that on after a stored closure was written
 * without it. Prefer the live opt-in so the capability fingerprint and approval
 * page always see visitor sharing when the package declares it.
 */
export function mergeOwnNeedsOntoClosure(input: {
	closure: ReadonlyArray<CredentialNeed> | undefined
	own: ReadonlyArray<CredentialNeed>
}): Array<CredentialNeed> {
	if (!input.closure || input.closure.length === 0) return [...input.own]
	const byKey = new Map(input.closure.map((need) => [need.key, need]))
	for (const need of input.own) {
		const existing = byKey.get(need.key)
		if (!existing) {
			byKey.set(need.key, need)
			continue
		}
		if (
			need.ownerCredentialForVisitors === true &&
			existing.ownerCredentialForVisitors !== true
		) {
			byKey.set(need.key, {
				...existing,
				ownerCredentialForVisitors: true,
			})
		}
	}
	return [...byKey.values()]
}

export type PackageCapabilityComputeResult = {
	capabilitySet: CapabilitySet
	dependencySnapshot: PackageDependencySnapshot
}

/**
 * Compute the capability set for a package including transitive dependency
 * packages from the resolved published tree, and the lockfile-like dependency
 * snapshot used for internet-visible approval pins.
 *
 * Prefer dependencies recorded on the published `app` (or `module`) bundle
 * artifact for the root published commit. Fall back to walking declared
 * `kody.dependencies` when no artifact deps exist yet.
 *
 * Each package contributes only what it declares or was granted: credentials
 * that fill its `kody.credentials` needs, its `kody.secretMounts`, its
 * package-scoped credentials, credentials the owner granted it, and package
 * storage when its published source uses it. Implicit user-credential read
 * (self-authored packages) is not a declaration, so it adds nothing here.
 *
 * Callers must only invoke this when a published commit exists. Manifest load
 * failures fail closed (throw) so approval cannot silently omit mounts.
 * Secret values never enter this path — only credential ids, hosts, and names.
 */
export async function computePackageCapabilitySet(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	requestUrl: string
	publishedCommit: string
}): Promise<PackageCapabilityComputeResult> {
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const entries: Array<CapabilitySetEntry> = []
	const viaRoot = [input.packageKodyId]
	const reachableByPackage = new Map<string, Promise<Array<UsableCredential>>>()
	const loadReachableCredentials = (packageId: string) => {
		const existing = reachableByPackage.get(packageId)
		if (existing) return existing
		const next = listOrgReachableCredentials({
			db: input.env.APP_DB,
			orgId: input.ownerUserId,
			packageId,
		}).then(liveUsableCredentials)
		reachableByPackage.set(packageId, next)
		return next
	}

	await appendPackageCapabilityEntries({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		baseUrl,
		via: viaRoot,
		entries,
		loadReachableCredentials,
		// The root runs its whole published closure, inherited needs included,
		// and its mappings are stored against those keys on the root package.
		needs: await loadPublishedCredentialNeeds({
			env: input.env,
			userId: input.ownerUserId,
			sourceId: input.sourceId,
		}),
	})

	const dependencySnapshot = await resolveDependencySnapshot({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		baseUrl,
		requestUrl: input.requestUrl,
	})

	for (const dependency of dependencySnapshot.dependencies) {
		// Only recorded packageId participates in capability union. Legacy
		// artifacts without packageId still appear in the snapshot pin, but
		// runtime grants require bundler provenance packageId.
		const packageId = dependency.packageId?.trim()
		if (!packageId) continue
		// Artifact dependency lists are flat (no parent chain). Provenance is
		// root → dependency kodyId; full intermediate paths need the graph walk
		// (manifest fallback tracks depth only as transitive today).
		const via = [input.packageKodyId, dependency.kodyId]
		await appendPackageCapabilityEntries({
			env: input.env,
			ownerUserId: input.ownerUserId,
			packageId,
			sourceId: dependency.sourceId,
			publishedCommit: dependency.publishedCommit,
			baseUrl,
			via,
			entries,
			loadReachableCredentials,
		})
	}

	return {
		capabilitySet: await buildCapabilitySet(entries),
		dependencySnapshot,
	}
}

async function resolveDependencySnapshot(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	packageKodyId: string
	sourceId: string
	publishedCommit: string
	baseUrl: string
	requestUrl: string
}): Promise<PackageDependencySnapshot> {
	const root = emptyDependencySnapshot({
		packageId: input.packageId,
		kodyId: input.packageKodyId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})

	const rootManifest = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.ownerUserId,
		sourceId: input.sourceId,
	})
	const hasApp = Boolean(rootManifest.manifest.kody.app?.entry?.trim())
	const fromArtifact = await loadDependenciesFromPublishedArtifact({
		env: input.env,
		ownerUserId: input.ownerUserId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		// Internet-visible is an app-serving flag. Never substitute a module
		// artifact's dependency list for an app package's approval pin.
		preferKind: hasApp ? 'app' : 'module',
	})
	if (fromArtifact) {
		return canonicalizeDependencySnapshot({
			...root,
			dependencies: fromArtifact,
		})
	}

	const fromManifest = await walkDeclaredKodyDependencies({
		env: input.env,
		ownerUserId: input.ownerUserId,
		sourceId: input.sourceId,
		baseUrl: input.baseUrl,
		rootPackageName: rootManifest.manifest.name,
	})
	return canonicalizeDependencySnapshot({
		...root,
		dependencies: fromManifest,
	})
}

async function loadDependenciesFromPublishedArtifact(input: {
	env: Env
	ownerUserId: OwnerId
	sourceId: string
	publishedCommit: string
	preferKind: 'app' | 'module'
}): Promise<Array<BundleArtifactDependency> | null> {
	const rows = (
		await listPublishedBundleArtifactsBySourceId(
			input.env.APP_DB,
			input.ownerUserId,
			input.sourceId,
		)
	).filter((row) => row.publishedCommit === input.publishedCommit)
	const preferred = rows.find((row) => row.artifactKind === input.preferKind)
	if (!preferred) return null
	try {
		const parsed = JSON.parse(preferred.dependenciesJson) as unknown
		// Wrong-shaped dependenciesJson is treated like malformed JSON so
		// resolveDependencySnapshot falls back to the declared-deps walk.
		if (!Array.isArray(parsed)) return null
		const dependencies: Array<BundleArtifactDependency> = []
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue
			const dep = entry as Record<string, unknown>
			const sourceId = String(dep.sourceId ?? '')
			const publishedCommit = String(dep.publishedCommit ?? '')
			const kodyId = String(dep.kodyId ?? '')
			if (!sourceId || !publishedCommit || !kodyId) continue
			const dependency: BundleArtifactDependency = {
				sourceId,
				publishedCommit,
				kodyId,
			}
			if (typeof dep.packageName === 'string' && dep.packageName.trim()) {
				dependency.packageName = dep.packageName
			}
			if (typeof dep.packageId === 'string' && dep.packageId.trim()) {
				dependency.packageId = dep.packageId
			}
			if (dep.transitive === true) {
				dependency.transitive = true
			}
			dependencies.push(dependency)
		}
		return dependencies
	} catch {
		// Malformed dependenciesJson: fall through to declared-deps walk.
		return null
	}
}

async function walkDeclaredKodyDependencies(input: {
	env: Env
	ownerUserId: OwnerId
	sourceId: string
	baseUrl: string
	rootPackageName: string
}): Promise<Array<BundleArtifactDependency>> {
	const dependencies = new Map<string, BundleArtifactDependency>()
	const visitedSourceIds = new Set<string>([input.sourceId])
	const queue: Array<{ sourceId: string; depth: number }> = [
		{ sourceId: input.sourceId, depth: 0 },
	]

	while (queue.length > 0) {
		const next = queue.shift()
		if (!next) continue
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.ownerUserId,
			sourceId: next.sourceId,
		})
		const names = listKodyPackageDependencyNames(
			loaded.manifest.kody.dependencies,
		)
		for (const packageName of names) {
			if (input.rootPackageName && packageName === input.rootPackageName) {
				continue
			}
			const resolution = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.ownerUserId,
				specifier: { packageName, exportName: '.' },
			})
			if (!resolution) continue
			const source = await getEntitySourceById(
				input.env.APP_DB,
				resolution.row.sourceId,
			)
			const publishedCommit = source?.published_commit ?? null
			if (!publishedCommit) continue
			if (!dependencies.has(resolution.row.id)) {
				const dependency: BundleArtifactDependency = {
					sourceId: resolution.row.sourceId,
					publishedCommit,
					kodyId: resolution.row.kodyId,
					packageName: resolution.row.name,
					packageId: resolution.row.id,
				}
				if (next.depth > 0) {
					dependency.transitive = true
				}
				dependencies.set(resolution.row.id, dependency)
			}
			if (!visitedSourceIds.has(resolution.row.sourceId)) {
				visitedSourceIds.add(resolution.row.sourceId)
				queue.push({
					sourceId: resolution.row.sourceId,
					depth: next.depth + 1,
				})
			}
		}
	}

	return [...dependencies.values()]
}

async function appendPackageCapabilityEntries(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	sourceId: string
	publishedCommit: string
	baseUrl: string
	via: Array<string>
	entries: Array<CapabilitySetEntry>
	loadReachableCredentials: (
		packageId: string,
	) => Promise<Array<UsableCredential>>
	/** Needs beyond the package's own manifest (the root's published closure). */
	needs?: ReadonlyArray<CredentialNeed>
}): Promise<void> {
	const [loaded, usesStorage] = await Promise.all([
		loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.ownerUserId,
			sourceId: input.sourceId,
		}),
		publishedPackageUsesStorage({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
		}),
	])
	if (usesStorage) {
		input.entries.push({
			kind: 'storage',
			storageId: input.packageId,
			hosts: [],
			via: input.via,
		})
	}
	const userMountNames = new Set<string>()
	for (const mount of Object.values(loaded.manifest.kody.secretMounts ?? {})) {
		const name = mount.name.trim()
		if (!name) continue
		const scope = mount.scope ?? 'user'
		if (scope === 'user') userMountNames.add(name)
	}

	const packageStorageContext = {
		sessionId: null,
		appId: input.packageId,
		packageId: input.packageId,
		storageId: input.packageId,
	}

	const [userSecrets, packageSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: input.ownerUserId,
			scope: 'user',
		}),
		listSecrets({
			env: input.env,
			userId: input.ownerUserId,
			scope: 'package',
			storageContext: packageStorageContext,
		}),
	])

	const seenCredentialIds = new Set<string>()
	for (const secret of packageSecrets) {
		if (seenCredentialIds.has(secret.credentialId)) continue
		seenCredentialIds.add(secret.credentialId)
		input.entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			source: 'package',
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via: input.via,
		})
	}
	for (const secret of userSecrets) {
		if (seenCredentialIds.has(secret.credentialId)) continue
		const mounted = userMountNames.has(secret.name)
		const granted = secret.allowedPackages.includes(input.packageId)
		if (!granted && !mounted) continue
		seenCredentialIds.add(secret.credentialId)
		input.entries.push({
			kind: 'credential',
			credentialId: secret.credentialId,
			name: secret.name,
			source: mounted ? 'mount' : 'grant',
			credentialKind: 'secret',
			hosts: secret.allowedHosts,
			placement: null,
			via: input.via,
		})
	}

	const needs = mergeOwnNeedsOntoClosure({
		closure: input.needs,
		own: ownCredentialNeeds(loaded.manifest.kody.credentials),
	})
	if (needs.length === 0) return
	const [reachableCredentials, mappings] = await Promise.all([
		input.loadReachableCredentials(input.packageId),
		loadAllCredentialMappingsForPackage({
			db: input.env.APP_DB,
			orgId: input.ownerUserId,
			packageId: input.packageId,
		}),
	])
	const reachableById = new Map(
		reachableCredentials.map((credential) => [credential.id, credential]),
	)
	// A credential visitors may use through a need is its own entry even when
	// the package also reaches it another way, so the flag always reaches the
	// fingerprint and the approval page.
	const seenVisitorEntries = new Set<string>()
	for (const need of needs) {
		const forVisitors = need.ownerCredentialForVisitors === true
		// A stored mapping (any layer) can point the need at a credential the
		// provider match would not pick, so list those too.
		const mapped = mappings
			.filter((row) => row.needKey === need.key)
			.flatMap((row) => row.credentialIds)
			.flatMap((id) => {
				const credential = reachableById.get(id)
				return credential ? [credential] : []
			})
		const resolution = resolveNeedCandidates(need, reachableCredentials)
		const fromResolution = resolution.autoPick
			? [resolution.autoPick]
			: resolution.candidates
		for (const candidate of [...mapped, ...fromResolution]) {
			if (forVisitors) {
				const visitorKey = `${need.key}\0${candidate.id}`
				if (seenVisitorEntries.has(visitorKey)) continue
				seenVisitorEntries.add(visitorKey)
			} else if (seenCredentialIds.has(candidate.id)) {
				continue
			}
			seenCredentialIds.add(candidate.id)
			input.entries.push({
				kind: 'credential',
				credentialId: candidate.id,
				name: candidate.name,
				source: 'need',
				needKey: need.key,
				...(forVisitors ? { ownerCredentialForVisitors: true as const } : {}),
				credentialKind: candidate.kind,
				hosts: candidate.hosts,
				placement: null,
				via: input.via,
			})
		}
	}
}

import {
	type CredentialReferenceVia,
	scanModuleCredentialReferences,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { listStaticDependentBundleArtifactRows } from '#worker/repo/published-bundle-artifacts-repo.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import {
	defaultStaticDependentArtifactsPerPackageLimit,
	defaultStaticDependentPackageLimit,
	getStaticPackageDependentsSummary,
	type StaticPackageDependentsSummary,
} from '#worker/package-runtime/static-package-dependents.ts'

const mountReadVias = new Set<CredentialReferenceVia>([
	'packageSecrets',
	'packageSecretGet',
	'packageSecretHas',
])

export type SecretMountDependentRead = {
	packageId: string
	name: string
	stale: boolean
	aliases: Array<string>
	/** True when the bundled snapshot could not be read or the alias is computed. */
	computed: boolean
}

type MountRead = { aliases: Array<string>; computed: boolean }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Alias list when `kody.secretMounts` is present, or null when the key is
 * absent. An empty object is an empty list, not "no key".
 */
export function readSecretMountAliases(
	manifestSource: string | null | undefined,
): Array<string> | null {
	if (manifestSource == null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return null
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return null
	if (!Object.hasOwn(parsed.kody, 'secretMounts')) return null
	const mounts = parsed.kody.secretMounts
	if (!isPlainObject(mounts)) return []
	return Object.keys(mounts).sort()
}

export function scopePackageSourceFiles(
	files: Record<string, string>,
	sourceRoot = '',
) {
	const root = normalizeRepoWorkspacePath(sourceRoot).replace(/\/+$/, '')
	if (!root) return files
	const prefix = `${root}/`
	return Object.fromEntries(
		Object.entries(files)
			.filter(([path]) => path.startsWith(prefix))
			.map(([path, content]) => [path.slice(prefix.length), content]),
	)
}

/** Gate/check note. Names the aliases; dependent names are added at publish. */
export function secretMountsKeptCompatNote(aliases: ReadonlyArray<string>) {
	const list = aliases.length > 0 ? aliases.join(', ') : '(none)'
	return `kody.secretMounts kept only for stale static dependents: ${list}. Removing a mount or deleting its secret breaks those dependents.`
}

/**
 * Literal `packageSecrets.get` / `packageSecretGet` / `has` aliases in a
 * bundled source snapshot. Computed aliases set `computed` so callers warn
 * without inventing a name.
 */
export function bundledPackageSecretMountReads(
	files: Record<string, string>,
): MountRead {
	const aliases = new Set<string>()
	let computed = false
	scanModuleCredentialReferences(files, () => ({
		add: () => undefined,
		named: (name, _kind, via) => {
			if (mountReadVias.has(via)) aliases.add(name)
		},
		computed: (_kind, via) => {
			if (mountReadVias.has(via)) computed = true
		},
		unnamed: () => undefined,
	}))
	return { aliases: [...aliases].sort(), computed }
}

function addReader(
	readers: Map<string, Set<string>>,
	alias: string,
	name: string,
) {
	const names = readers.get(alias) ?? new Set<string>()
	names.add(name)
	readers.set(alias, names)
}

function formatNames(names: ReadonlySet<string> | ReadonlyArray<string>) {
	return [...names].sort().join(', ')
}

export type SecretMountCompatReport = {
	notice: string | null
	actionByPackageId: Map<string, string>
}

/**
 * Names stale static dependents that still call `packageSecrets.get` for a
 * kept mount, and the ones a removed alias will break. Grants nothing.
 */
export function describeSecretMountCompat(input: {
	keptAliases: ReadonlyArray<string>
	dependents: ReadonlyArray<SecretMountDependentRead>
	truncated?: boolean
}): SecretMountCompatReport {
	const kept = [...new Set(input.keptAliases)].sort()
	const keptSet = new Set(kept)
	const stale = input.dependents.filter((dependent) => dependent.stale)
	const readers = new Map<string, Set<string>>()
	const removed = new Set<string>()
	const actionByPackageId = new Map<string, string>()
	for (const dependent of stale) {
		const readAliases = new Set<string>()
		if (dependent.computed && dependent.aliases.length === 0) {
			for (const alias of kept) {
				addReader(readers, alias, dependent.name)
				readAliases.add(alias)
			}
		}
		for (const alias of dependent.aliases) {
			addReader(readers, alias, dependent.name)
			readAliases.add(alias)
			if (!keptSet.has(alias)) removed.add(alias)
		}
		const removedHere = [...readAliases].filter((alias) => !keptSet.has(alias))
		const keptHere = [...readAliases].filter((alias) => keptSet.has(alias))
		const parts: Array<string> = []
		if (removedHere.length > 0) {
			parts.push(
				`Removing secret mount ${removedHere.sort().join(', ')} breaks ${dependent.name}. Deleting the secret breaks it too.`,
			)
		}
		if (keptHere.length > 0) {
			parts.push(
				`This stale dependent still reads kept secret mount ${keptHere.sort().join(', ')}. Removing that mount or deleting its secret breaks ${dependent.name}.`,
			)
		}
		if (parts.length > 0)
			actionByPackageId.set(dependent.packageId, parts.join(' '))
	}
	const lines: Array<string> = []
	const removedAliases = [...removed].sort()
	if (removedAliases.length > 0) {
		const names = new Set<string>()
		for (const alias of removedAliases) {
			for (const name of readers.get(alias) ?? []) names.add(name)
		}
		lines.push(
			`This publish removes secret mount ${removedAliases.join(', ')}. Stale static dependents still bundling ${removedAliases.length === 1 ? 'that mount' : 'those mounts'}: ${formatNames(names)}. Removing the mount or deleting the secret will break those dependents.`,
		)
	}
	const keptRead = kept.filter((alias) => (readers.get(alias)?.size ?? 0) > 0)
	if (keptRead.length > 0) {
		const names = new Set<string>()
		for (const alias of keptRead) {
			for (const name of readers.get(alias) ?? []) names.add(name)
		}
		lines.push(
			`kody.secretMounts kept only for stale static dependents: ${keptRead.join(', ')}. Still read by ${formatNames(names)}. Removing a mount or deleting its secret breaks those dependents.`,
		)
	} else if (kept.length > 0 && removedAliases.length === 0) {
		lines.push(
			`${secretMountsKeptCompatNote(kept)} No stale static dependent still reads them. Delete a mount only once static_dependents shows no stale bundle still calling packageSecrets.get for it.`,
		)
	}
	if (input.truncated && lines.length > 0) {
		lines.push(
			'The static_dependents list is truncated; more stale dependents may also break.',
		)
	}
	return {
		notice: lines.length > 0 ? lines.join(' ') : null,
		actionByPackageId,
	}
}

export function applySecretMountCompatToSummary(
	summary: StaticPackageDependentsSummary,
	report: SecretMountCompatReport,
): StaticPackageDependentsSummary {
	if (report.notice == null && report.actionByPackageId.size === 0) {
		return summary
	}
	return {
		...summary,
		recommended_next_action: report.notice
			? `${summary.recommended_next_action} ${report.notice}`
			: summary.recommended_next_action,
		items: summary.items.map((item) => {
			const extra = report.actionByPackageId.get(item.package_id)
			if (!extra) return item
			return {
				...item,
				recommended_action: `${item.recommended_action} ${extra}`,
			}
		}),
	}
}

export function appendSecretMountCompatNotice(
	message: string,
	notice: string | null | undefined,
) {
	if (!notice) return message
	return `${message}\n\n${notice}`
}

async function readsAtCommit(input: {
	env: Env
	sourceId: string
	commit: string
	cache: Map<string, MountRead>
}) {
	const cached = input.cache.get(input.commit)
	if (cached) return cached
	const snapshot = await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.commit,
	})
	const read = snapshot?.files
		? bundledPackageSecretMountReads(snapshot.files)
		: { aliases: [], computed: true }
	input.cache.set(input.commit, read)
	return read
}

async function dependentReads(input: {
	env: Env
	userId: string
	sourceId: string
	nextCommit: string
}): Promise<{
	dependents: Array<SecretMountDependentRead>
}> {
	const rows = await listStaticDependentBundleArtifactRows(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.sourceId,
		currentDependencyCommit: input.nextCommit,
		packageLimit: defaultStaticDependentPackageLimit,
		artifactsPerPackageLimit: defaultStaticDependentArtifactsPerPackageLimit,
	})
	const cache = new Map<string, MountRead>()
	const byPackage = new Map<string, SecretMountDependentRead>()
	for (const row of rows) {
		const existing = byPackage.get(row.packageId) ?? {
			packageId: row.packageId,
			name: row.packageName,
			stale: false,
			aliases: [],
			computed: false,
		}
		byPackage.set(row.packageId, existing)
		if (!row.packageStale) continue
		existing.stale = true
		const commit = row.bundledDependencyCommit
		if (!commit) {
			existing.computed = true
			continue
		}
		const read = await readsAtCommit({
			env: input.env,
			sourceId: input.sourceId,
			commit,
			cache,
		})
		existing.aliases = [
			...new Set([...existing.aliases, ...read.aliases]),
		].sort()
		existing.computed = existing.computed || read.computed
	}
	return {
		dependents: [...byPackage.values()],
	}
}

function manifestSourceFromFiles(
	files: Record<string, string> | null | undefined,
) {
	if (!files) return null
	return files['package.json'] ?? null
}

/**
 * Publish/approve warning from bundle-artifact rows plus the dependency
 * source snapshot those rows already pinned. Failures become "no notice"
 * so a dependents lookup cannot fail the publish itself.
 */
export async function loadSecretMountCompatNotice(input: {
	env: Env
	userId: string
	sourceId: string
	nextCommit: string
	nextFiles?: Record<string, string> | null
	sourceRoot?: string
}): Promise<string | null> {
	try {
		const scoped = input.nextFiles
			? scopePackageSourceFiles(input.nextFiles, input.sourceRoot)
			: null
		let manifestSource = manifestSourceFromFiles(scoped)
		if (manifestSource == null) {
			const snapshot = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: input.sourceId,
				publishedCommit: input.nextCommit,
			})
			manifestSource =
				(snapshot?.manifestPath
					? snapshot.files[snapshot.manifestPath]
					: undefined) ??
				snapshot?.files['package.json'] ??
				null
		}
		const keptAliases = readSecretMountAliases(manifestSource) ?? []
		const summary = await getStaticPackageDependentsSummary({
			db: input.env.APP_DB,
			userId: input.userId,
			sourceId: input.sourceId,
			currentDependencyCommit: input.nextCommit,
		})
		const { dependents } = await dependentReads({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			nextCommit: input.nextCommit,
		})
		if (keptAliases.length === 0 && dependents.every((row) => !row.stale)) {
			return null
		}
		return describeSecretMountCompat({
			keptAliases,
			dependents,
			truncated: summary.truncated,
		}).notice
	} catch {
		// Best-effort. A missing artifacts binding or a dependents query
		// failure omits the warning and does not fail the publish.
		return null
	}
}

export async function annotateStaticDependentsWithSecretMounts(input: {
	env: Env
	userId: string
	sourceId: string
	nextCommit: string
	summary: StaticPackageDependentsSummary
	nextFiles?: Record<string, string> | null
}): Promise<StaticPackageDependentsSummary> {
	try {
		let manifestSource = manifestSourceFromFiles(input.nextFiles)
		if (manifestSource == null) {
			const snapshot = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: input.sourceId,
				publishedCommit: input.nextCommit,
			})
			manifestSource =
				(snapshot?.manifestPath
					? snapshot.files[snapshot.manifestPath]
					: undefined) ??
				snapshot?.files['package.json'] ??
				null
		}
		const keptAliases = readSecretMountAliases(manifestSource) ?? []
		const { dependents } = await dependentReads({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			nextCommit: input.nextCommit,
		})
		const report = describeSecretMountCompat({
			keptAliases,
			dependents,
			truncated: input.summary.truncated,
		})
		return applySecretMountCompatToSummary(input.summary, report)
	} catch {
		return input.summary
	}
}

import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { linkedPackageImportPrefix } from './module-graph-paths.ts'

/**
 * A build uploaded from outside Kody cloud carries each `kody:@` dependency's
 * published artifact as its own modules under `.__kody_linked__/artifacts/…`.
 * Those module groups are stored here, once per published commit and content
 * hash, and the artifact keeps a reference. Several targets that import the
 * same dependency share one blob when the hash matches.
 *
 * Keys are scoped to the importing source and commit, so a group is deleted
 * with that commit's artifacts and never needs reference counting.
 */
const linkedArtifactStorePrefix = 'linked-artifact'
const linkedArtifactStoreVersion = 1
const linkedArtifactsMarker = `${linkedPackageImportPrefix}/artifacts/`
const fullPathChunk = /^[0-9a-f]{96}$/
const lastPathChunk = /^[0-9a-f]{1,95}$/

/** Where one group of linked modules is stored, kept on the artifact. */
export type StoredLinkedArtifactReference = {
	/** Path the group's modules sit under in the artifact. */
	prefix: string
	sha256: string
}

type StoredModules = Record<string, unknown>

export function linkedArtifactSourceKvPrefix(sourceId: string) {
	return `${linkedArtifactStorePrefix}:v${linkedArtifactStoreVersion}:${sourceId}:`
}

export function linkedArtifactCommitKvPrefix(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${linkedArtifactSourceKvPrefix(input.sourceId)}${input.publishedCommit}:`
}

/**
 * The linked artifact directory `modulePath` sits in, or null. The directory
 * name is the hex chunks `encodePathKeyAsPath` writes. A shorter or longer
 * match only changes how modules are grouped, never where they are restored.
 */
function linkedArtifactGroupPrefix(modulePath: string) {
	const markerIndex = `/${modulePath}`.indexOf(`/${linkedArtifactsMarker}`)
	if (markerIndex === -1) return null
	const start = markerIndex + linkedArtifactsMarker.length
	const segments = modulePath.slice(start).split('/')
	let consumed = 0
	while (
		consumed < segments.length - 1 &&
		fullPathChunk.test(segments[consumed]!)
	) {
		consumed += 1
	}
	if (
		consumed < segments.length - 1 &&
		lastPathChunk.test(segments[consumed]!)
	) {
		consumed += 1
	}
	if (consumed === 0) return null
	return modulePath.slice(0, start) + segments.slice(0, consumed).join('/')
}

const writtenKeyTtlMs = 5 * 60_000
const writtenKeyLimit = 5_000
/**
 * Groups this isolate stored recently. One publish writes about a hundred
 * targets that link the same dependencies, so each group is put once.
 */
const recentWrites = new Map<
	string,
	{ expiresAt: number; pending: Promise<void> }
>()

async function putOnce(kv: KVNamespace, key: string, value: string) {
	const now = Date.now()
	const recent = recentWrites.get(key)
	if (recent && recent.expiresAt > now) return await recent.pending
	if (recentWrites.size >= writtenKeyLimit) recentWrites.clear()
	const pending = kv.put(key, value)
	recentWrites.set(key, { expiresAt: now + writtenKeyTtlMs, pending })
	try {
		await pending
	} catch (error) {
		if (recentWrites.get(key)?.pending === pending) recentWrites.delete(key)
		throw error
	}
}

/**
 * Stores each linked artifact group of `modules` under its content hash and
 * returns the modules that stay on the artifact plus the references.
 */
export async function storeLinkedArtifactGroups(input: {
	kv: KVNamespace
	sourceId: string
	publishedCommit: string
	modules: StoredModules
}): Promise<{
	modules: StoredModules
	linkedArtifacts: Array<StoredLinkedArtifactReference>
}> {
	const groups = new Map<string, Array<[string, unknown]>>()
	const own: StoredModules = {}
	for (const [modulePath, module] of Object.entries(input.modules)) {
		const prefix = linkedArtifactGroupPrefix(modulePath)
		if (prefix === null) {
			own[modulePath] = module
			continue
		}
		const group = groups.get(prefix) ?? []
		group.push([modulePath.slice(prefix.length + 1), module])
		groups.set(prefix, group)
	}
	if (groups.size === 0) return { modules: own, linkedArtifacts: [] }
	const keyPrefix = linkedArtifactCommitKvPrefix(input)
	const linkedArtifacts = await Promise.all(
		[...groups].map(async ([prefix, entries]) => {
			entries.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			)
			const serialized = JSON.stringify(Object.fromEntries(entries))
			const sha256 = await sha256Hex(serialized)
			await putOnce(input.kv, `${keyPrefix}${sha256}`, serialized)
			return { prefix, sha256 }
		}),
	)
	linkedArtifacts.sort((left, right) =>
		left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0,
	)
	return { modules: own, linkedArtifacts }
}

function parseReferences(value: unknown) {
	if (!Array.isArray(value)) return null
	const references: Array<StoredLinkedArtifactReference> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') return null
		const { prefix, sha256 } = entry as Record<string, unknown>
		if (typeof prefix !== 'string' || typeof sha256 !== 'string') return null
		references.push({ prefix, sha256 })
	}
	return references
}

/**
 * Puts referenced linked artifact groups back into a stored artifact's
 * modules, so readers see the modules the artifact was written with. Returns
 * null when a group is missing or unreadable: the artifact cannot be served.
 * A payload with no references is returned as is.
 */
export async function restoreLinkedArtifactGroups(input: {
	kv: KVNamespace
	stored: unknown
}): Promise<unknown> {
	const { stored } = input
	if (!stored || typeof stored !== 'object') return stored
	const artifact = stored as Record<string, unknown>
	if (artifact['linkedArtifacts'] === undefined) return stored
	const references = parseReferences(artifact['linkedArtifacts'])
	const { sourceId, publishedCommit, modules } = artifact
	if (
		references === null ||
		typeof sourceId !== 'string' ||
		typeof publishedCommit !== 'string' ||
		!modules ||
		typeof modules !== 'object'
	) {
		return null
	}
	const keyPrefix = linkedArtifactCommitKvPrefix({ sourceId, publishedCommit })
	const groups = await Promise.all(
		references.map((reference) =>
			input.kv.get(`${keyPrefix}${reference.sha256}`, 'json'),
		),
	)
	const restored: StoredModules = { ...(modules as StoredModules) }
	for (const [index, group] of groups.entries()) {
		const reference = references[index]!
		if (!group || typeof group !== 'object' || Array.isArray(group)) {
			console.warn('published-bundle-linked-artifact-missing', {
				sourceId,
				publishedCommit,
				prefix: reference.prefix,
				sha256: reference.sha256,
			})
			return null
		}
		for (const [relativePath, module] of Object.entries(group)) {
			restored[`${reference.prefix}/${relativePath}`] = module
		}
	}
	const { linkedArtifacts: _linkedArtifacts, ...rest } = artifact
	return { ...rest, modules: restored }
}

/** Deletes every stored linked artifact group under `prefix`. */
export async function deleteLinkedArtifactGroups(input: {
	kv: KVNamespace
	prefix: string
}) {
	if (typeof input.kv.list !== 'function') return 0
	let deleted = 0
	let cursor: string | undefined
	do {
		const page = await input.kv.list({ prefix: input.prefix, cursor })
		await Promise.all(page.keys.map((key) => input.kv.delete(key.name)))
		for (const key of page.keys) recentWrites.delete(key.name)
		deleted += page.keys.length
		cursor = page.list_complete ? undefined : page.cursor
	} while (cursor)
	return deleted
}

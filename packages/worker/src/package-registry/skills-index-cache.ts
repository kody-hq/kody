import { deleteKvKeysByPrefix } from '../kv-delete.ts'
import {
	packageSkillsIndexVersion,
	type PackageSkillsIndex,
} from './package-skills.ts'

const skillsIndexCachePrefix = 'package-skills-index'

function getSkillsKv(env: Env) {
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error('Missing BUNDLE_ARTIFACTS_KV binding for package skills.')
	}
	return kv
}

export function hasPackageSkillsKv(env: Env) {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV != null
	)
}

export function buildPackageSkillsIndexKey(input: {
	userId: string
	packageId: string
	publishedCommit: string
}) {
	return [
		skillsIndexCachePrefix,
		`v${packageSkillsIndexVersion}`,
		input.userId,
		input.packageId,
		input.publishedCommit,
	].join(':')
}

export function buildPackageSkillsIndexPrefix(input: {
	userId: string
	packageId: string
}) {
	return (
		[
			skillsIndexCachePrefix,
			`v${packageSkillsIndexVersion}`,
			input.userId,
			input.packageId,
		].join(':') + ':'
	)
}

/** Archived indexes are immutable per published commit, not mutable drafts. */
export async function listPackageSkillsIndexes(input: {
	env: Env
	userId: string
	packageId: string
}) {
	const kv = getSkillsKv(input.env)
	const prefix = buildPackageSkillsIndexPrefix(input)
	const indexes: Array<PackageSkillsIndex> = []
	let cursor: string | undefined
	do {
		const result = await kv.list({ prefix, cursor })
		const keys = result.keys.map((key) => key.name)
		// Bound concurrent KV reads even for packages with long histories.
		for (let offset = 0; offset < keys.length; offset += 10) {
			const batch = await Promise.all(
				keys.slice(offset, offset + 10).map(async (key) => {
					if (!key.startsWith(prefix))
						throw new Error('Invalid skills history key.')
					return readPackageSkillsIndex({
						...input,
						publishedCommit: key.slice(prefix.length),
					})
				}),
			)
			for (const index of batch) if (index) indexes.push(index)
		}
		cursor = result.list_complete ? undefined : result.cursor
	} while (cursor)
	return indexes
}

function isPackageSkillsIndex(value: unknown): value is PackageSkillsIndex {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { version?: unknown }).version === packageSkillsIndexVersion &&
		typeof (value as { packageId?: unknown }).packageId === 'string' &&
		typeof (value as { publishedCommit?: unknown }).publishedCommit ===
			'string' &&
		Array.isArray((value as { skills?: unknown }).skills)
	)
}

/**
 * Writes the index for one package version. An index with an empty `skills`
 * array is a definitive "this version ships no skills" answer.
 */
export async function writePackageSkillsIndex(input: {
	env: Env
	userId: string
	index: PackageSkillsIndex
}) {
	const previous = await readPackageSkillsIndex({
		...input,
		packageId: input.index.packageId,
		publishedCommit: input.index.publishedCommit,
	})
	const index = {
		...input.index,
		...(previous?.publishedBy ? { publishedBy: previous.publishedBy } : {}),
		...(previous?.publishedAt ? { publishedAt: previous.publishedAt } : {}),
	}
	await getSkillsKv(input.env).put(
		buildPackageSkillsIndexKey({
			userId: input.userId,
			packageId: input.index.packageId,
			publishedCommit: input.index.publishedCommit,
		}),
		JSON.stringify(index),
	)
}

/** Returns `null` when KV is unbound, the key is missing, or the value is malformed. */
export async function readPackageSkillsIndex(input: {
	env: Env
	userId: string
	packageId: string
	publishedCommit: string
}): Promise<PackageSkillsIndex | null> {
	if (!hasPackageSkillsKv(input.env)) return null
	const stored = await getSkillsKv(input.env).get(
		buildPackageSkillsIndexKey(input),
		'json',
	)
	if (!isPackageSkillsIndex(stored)) return null
	if (
		stored.packageId !== input.packageId ||
		stored.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return stored
}

/** Deletes the indexes for every published commit of one package. */
export async function removePackageSkillsIndexEntries(input: {
	env: Env
	userId: string
	packageId: string
}) {
	if (!hasPackageSkillsKv(input.env)) return
	await deleteKvKeysByPrefix({
		kv: getSkillsKv(input.env),
		prefix: buildPackageSkillsIndexPrefix(input),
	})
}

/** Deletes every package skills index owned by a user (account deletion). */
export async function deleteAllPackageSkillsIndexEntriesForUser(input: {
	env: Env
	userId: string
}) {
	if (!hasPackageSkillsKv(input.env)) return 0
	return await deleteKvKeysByPrefix({
		kv: getSkillsKv(input.env),
		prefix: `${skillsIndexCachePrefix}:v${packageSkillsIndexVersion}:${input.userId}:`,
	})
}

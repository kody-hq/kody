/**
 * Package-shipped Agent Skills (https://agentskills.io/specification).
 *
 * A package may ship skills at `skills/<name>/SKILL.md`. Publish validates each
 * skill, digests every file under its directory, and stores a content-free
 * index per package version (see `skills-index-cache.ts`). File content is read
 * from the published snapshot at `resources/read` time and verified against
 * the stored digest. This module is pure: no Env, no I/O.
 */

import {
	shouldStoreArtifactBlobAsLatin1,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'

export const packageSkillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const packageSkillNameMaxLength = 64
export const packageSkillDescriptionMaxLength = 1024
export const packageSkillMaxFiles = 512
export const packageSkillMaxBytes = 16 * 1024 * 1024
export const packageSkillsIndexVersion = 1

const skillManifestPathPattern = /^skills\/([^/]+)\/SKILL\.md$/
const skillScalarOptionalKeys = [
	'license',
	'compatibility',
	'allowed-tools',
] as const

export type PackageSkillResource = {
	/** Path relative to skill root, e.g. `SKILL.md` or `references/x.md` */
	relativePath: string
	/** Absolute package path, e.g. `skills/foo/SKILL.md` */
	packagePath: string
	/** `skill://...` URI */
	uri: string
	/** `sha256:{64 hex}` */
	digest: string
	/** Raw byte length (latin-1 for binary snapshot paths, UTF-8 otherwise) */
	size: number
	/** Snapshot-stored content string (latin-1 for binary paths) */
	content: string
	mimeType: string
}

export type PackageSkillFrontmatter = {
	name: string
	description: string
	[key: string]: unknown
}

export type PackageSkillEntry = {
	name: string
	/** Organizational prefix segments before the skill name, e.g. `['kentcdodds','ship-pr']` */
	uriPrefix: ReadonlyArray<string>
	/** Full skill URI for SKILL.md */
	uri: string
	frontmatter: PackageSkillFrontmatter
	resources: ReadonlyArray<PackageSkillResource>
	/** `skills/<name>` */
	skillRoot: string
}

export type PackageSkillResourceIndexEntry = Omit<
	PackageSkillResource,
	'content'
>

export type PackageSkillIndexEntry = Omit<PackageSkillEntry, 'resources'> & {
	resources: ReadonlyArray<PackageSkillResourceIndexEntry>
}

/**
 * KV-stored index. Carries everything `skills/list` and `skills/get` need
 * without file contents.
 */
export type PackageSkillsIndex = {
	version: typeof packageSkillsIndexVersion
	packageId: string
	kodyId: string
	publishedCommit: string
	skills: ReadonlyArray<PackageSkillIndexEntry>
}

export type PackageSkillsLimits = {
	maxFiles?: number
	maxBytes?: number
}

export type ValidatePackageSkillsResult =
	| { ok: true; skills: ReadonlyArray<PackageSkillEntry>; message: string }
	| { ok: false; message: string }

export function parseKodyIdForSkillUri(kodyId: string): {
	owner: string
	slug: string
} {
	const withoutAt = kodyId.startsWith('@') ? kodyId.slice(1) : kodyId
	const parts = withoutAt.split('/')
	const [owner, slug] = parts
	if (parts.length !== 2 || !owner || !slug) {
		throw new Error(
			`Cannot build skill URIs for package "${kodyId}": expected a scoped id like "@owner/slug".`,
		)
	}
	return { owner, slug }
}

export function buildSkillUri(
	prefixSegments: ReadonlyArray<string>,
	relativePath: string,
) {
	const trimmedPath = relativePath.replace(/^\/+/, '').replace(/\/+$/, '')
	return `skill://${prefixSegments.join('/')}/${trimmedPath}`
}

/**
 * Digest and size of a snapshot-stored file. Binary paths (and NUL-bearing
 * strings) use the latin-1 byte view; everything else is UTF-8 — matching how
 * published snapshots store content.
 */
export async function digestSnapshotContent(
	content: string,
	packagePath: string,
): Promise<{ digest: string; size: number; bytes: Uint8Array }> {
	const bytes = snapshotStringToBytes(content, packagePath)
	const hash = await crypto.subtle.digest('SHA-256', bytes)
	const hex = Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return { digest: `sha256:${hex}`, size: bytes.byteLength, bytes }
}

export function skillResourceIsBinary(packagePath: string, content: string) {
	return content.includes('\0') || shouldStoreArtifactBlobAsLatin1(packagePath)
}

export function bytesToBase64(bytes: Uint8Array) {
	let binary = ''
	const chunkSize = 0x8000
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
	}
	return btoa(binary)
}

export function guessMimeType(path: string): string {
	const dotIndex = path.lastIndexOf('.')
	const extension =
		dotIndex === -1 ? '' : path.slice(dotIndex + 1).toLowerCase()
	switch (extension) {
		case 'md':
			return 'text/markdown'
		case 'json':
			return 'application/json'
		case 'js':
		case 'ts':
		case 'mjs':
		case 'cjs':
			return 'text/plain'
		case 'py':
			return 'text/x-python'
		case 'sh':
			return 'application/x-sh'
		case 'png':
			return 'image/png'
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg'
		case 'gif':
			return 'image/gif'
		case 'webp':
			return 'image/webp'
		case 'svg':
			return 'image/svg+xml'
		case 'avif':
			return 'image/avif'
		default:
			return 'application/octet-stream'
	}
}

export function validatePackageSkillName(name: string): string | null {
	if (name.length < 1 || name.length > packageSkillNameMaxLength) {
		return `must be 1-${packageSkillNameMaxLength} characters`
	}
	if (!packageSkillNamePattern.test(name)) {
		return 'must use only lowercase letters, digits, and single hyphens, and must not start or end with a hyphen'
	}
	return null
}

function stripSurroundingQuotes(value: string) {
	if (value.length >= 2) {
		const first = value[0]
		const last = value[value.length - 1]
		if (first === '"' && last === '"') {
			return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
		}
		if (first === "'" && last === "'") {
			return value.slice(1, -1).replace(/''/g, "'")
		}
	}
	return value
}

const blockScalarIndicatorPattern = /^[>|][+-]?$/

type RawFrontmatterField =
	| { kind: 'scalar'; parts: Array<string> }
	| { kind: 'map'; entries: Array<{ key: string; value: string }> }

/**
 * Parse the `SKILL.md` frontmatter block. Supported shapes:
 *
 * ```
 * ---
 * name: my-skill
 * description: One line, "quoted", or continued
 *   on indented lines (joined with spaces).
 * license: MIT
 * metadata:
 *   author: me
 *   version: "1.0"
 * ---
 * ```
 *
 * Unknown top-level scalar keys are preserved verbatim. Throws with the skill
 * path on any malformed input.
 */
export function parseSkillFrontmatter(input: {
	skillPath: string
	raw: string
}): { frontmatter: PackageSkillFrontmatter; body: string } {
	const { skillPath } = input
	const normalized = input.raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		throw new Error(
			`Skill "${skillPath}" is missing the opening "---" frontmatter fence.`,
		)
	}
	const closeMatch = /\n---[ \t]*(?:\n|$)/.exec(normalized.slice(3))
	if (!closeMatch) {
		throw new Error(
			`Skill "${skillPath}" is missing the closing "---" frontmatter fence.`,
		)
	}
	const blockStart = 4
	const blockEnd = 3 + closeMatch.index
	const frontmatterBlock =
		blockEnd >= blockStart ? normalized.slice(blockStart, blockEnd) : ''
	const body = normalized
		.slice(3 + closeMatch.index + closeMatch[0].length)
		.replace(/^\n/, '')

	const fields = new Map<string, RawFrontmatterField>()
	let current: { key: string; field: RawFrontmatterField } | null = null

	for (const line of frontmatterBlock.split('\n')) {
		if (line.trim() === '' || line.trim().startsWith('#')) continue

		const isIndented = /^[ \t]/.test(line)
		if (isIndented) {
			if (!current) {
				throw new Error(
					`Skill "${skillPath}" has an unexpected indented frontmatter line: ${line.trim()}`,
				)
			}
			const text = line.trim()
			if (current.field.kind === 'map') {
				const colonIndex = text.indexOf(':')
				if (colonIndex === -1) {
					throw new Error(
						`Skill "${skillPath}" has an invalid "${current.key}" entry (expected "key: value"): ${text}`,
					)
				}
				current.field.entries.push({
					key: text.slice(0, colonIndex).trim(),
					value: text.slice(colonIndex + 1).trim(),
				})
			} else {
				current.field.parts.push(text)
			}
			continue
		}

		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) {
			throw new Error(
				`Skill "${skillPath}" has an invalid frontmatter line (expected "key: value"): ${line}`,
			)
		}
		const key = line.slice(0, colonIndex).trim()
		if (!key) {
			throw new Error(
				`Skill "${skillPath}" has a frontmatter line with an empty key: ${line}`,
			)
		}
		if (fields.has(key)) {
			throw new Error(
				`Skill "${skillPath}" declares frontmatter "${key}" more than once.`,
			)
		}
		const inlineValue = line.slice(colonIndex + 1).trim()
		const field: RawFrontmatterField =
			key === 'metadata' && inlineValue === ''
				? { kind: 'map', entries: [] }
				: {
						kind: 'scalar',
						parts:
							inlineValue === '' ||
							blockScalarIndicatorPattern.test(inlineValue)
								? []
								: [inlineValue],
					}
		fields.set(key, field)
		current = { key, field }
	}

	const frontmatter: Record<string, unknown> = {}
	for (const [key, field] of fields) {
		if (field.kind === 'map') {
			const metadata: Record<string, string> = {}
			for (const entry of field.entries) {
				if (!entry.key) {
					throw new Error(
						`Skill "${skillPath}" has a "metadata" entry with an empty key.`,
					)
				}
				metadata[entry.key] = stripSurroundingQuotes(entry.value)
			}
			frontmatter[key] = metadata
			continue
		}
		const joined = field.parts.join(' ').trim()
		if (key === 'metadata') {
			throw new Error(
				`Skill "${skillPath}" frontmatter "metadata" must be a map of string keys to string values.`,
			)
		}
		frontmatter[key] = stripSurroundingQuotes(joined)
	}

	const name = frontmatter['name']
	const description = frontmatter['description']
	if (typeof name !== 'string' || name === '') {
		throw new Error(`Skill "${skillPath}" is missing frontmatter "name".`)
	}
	if (typeof description !== 'string' || description === '') {
		throw new Error(
			`Skill "${skillPath}" is missing frontmatter "description".`,
		)
	}
	for (const key of skillScalarOptionalKeys) {
		const value = frontmatter[key]
		if (value !== undefined && typeof value !== 'string') {
			throw new Error(
				`Skill "${skillPath}" frontmatter "${key}" must be a string.`,
			)
		}
	}

	return {
		frontmatter: { ...frontmatter, name, description },
		body,
	}
}

function compareCodePoints(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0
}

function encodePathSegments(path: string) {
	return path.split('/').map(encodeURIComponent).join('/')
}

export async function collectPackageSkills(input: {
	files: Record<string, string>
	kodyId: string
	limits?: PackageSkillsLimits
}): Promise<ReadonlyArray<PackageSkillEntry>> {
	const maxFiles = input.limits?.maxFiles ?? packageSkillMaxFiles
	const maxBytes = input.limits?.maxBytes ?? packageSkillMaxBytes
	const allPaths = Object.keys(input.files)
	const skillNames = allPaths
		.map((path) => skillManifestPathPattern.exec(path)?.[1])
		.filter((name): name is string => name !== undefined)
		.sort(compareCodePoints)
	if (skillNames.length === 0) return []

	const { owner, slug } = parseKodyIdForSkillUri(input.kodyId)
	const uriPrefix = [owner, slug] as const
	const entries: Array<PackageSkillEntry> = []

	for (const directoryName of skillNames) {
		const skillRoot = `skills/${directoryName}`
		const skillPath = `${skillRoot}/SKILL.md`
		const nameProblem = validatePackageSkillName(directoryName)
		if (nameProblem) {
			throw new Error(
				`Skill directory "${skillRoot}" has an invalid name: ${nameProblem}.`,
			)
		}
		const { frontmatter } = parseSkillFrontmatter({
			skillPath,
			raw: input.files[skillPath]!,
		})
		if (frontmatter.name !== directoryName) {
			throw new Error(
				`Skill "${skillPath}" frontmatter name "${frontmatter.name}" must match its directory name "${directoryName}".`,
			)
		}
		if (frontmatter.description.length > packageSkillDescriptionMaxLength) {
			throw new Error(
				`Skill "${skillPath}" description must be 1-${packageSkillDescriptionMaxLength} characters (got ${frontmatter.description.length}).`,
			)
		}

		const skillFilePaths = allPaths
			.filter((path) => path.startsWith(`${skillRoot}/`))
			.sort((left, right) => {
				if (left === skillPath) return -1
				if (right === skillPath) return 1
				return compareCodePoints(left, right)
			})
		if (skillFilePaths.length > maxFiles) {
			throw new Error(
				`Skill "${skillRoot}" has ${skillFilePaths.length} files; the limit is ${maxFiles}.`,
			)
		}

		const resources: Array<PackageSkillResource> = []
		let totalBytes = 0
		for (const packagePath of skillFilePaths) {
			const content = input.files[packagePath]!
			const { digest, size } = await digestSnapshotContent(content, packagePath)
			totalBytes += size
			if (totalBytes > maxBytes) {
				throw new Error(
					`Skill "${skillRoot}" exceeds the ${maxBytes}-byte total size limit (at "${packagePath}").`,
				)
			}
			const relativePath = packagePath.slice(skillRoot.length + 1)
			resources.push({
				relativePath,
				packagePath,
				uri: buildSkillUri(
					uriPrefix,
					`${directoryName}/${encodePathSegments(relativePath)}`,
				),
				digest,
				size,
				content,
				mimeType: guessMimeType(relativePath),
			})
		}

		entries.push({
			name: directoryName,
			uriPrefix,
			uri: buildSkillUri(uriPrefix, `${directoryName}/SKILL.md`),
			frontmatter,
			resources,
			skillRoot,
		})
	}

	return entries
}

export async function validatePackageSkills(input: {
	files: Record<string, string>
	kodyId: string
	limits?: PackageSkillsLimits
}): Promise<ValidatePackageSkillsResult> {
	try {
		const skills = await collectPackageSkills(input)
		return {
			ok: true,
			skills,
			message:
				skills.length === 0
					? 'No package skills found.'
					: `Validated ${skills.length} package skill${skills.length === 1 ? '' : 's'}: ${skills.map((skill) => skill.name).join(', ')}.`,
		}
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		}
	}
}

export function buildPackageSkillsIndex(input: {
	packageId: string
	kodyId: string
	publishedCommit: string
	skills: ReadonlyArray<PackageSkillEntry>
}): PackageSkillsIndex {
	return {
		version: packageSkillsIndexVersion,
		packageId: input.packageId,
		kodyId: input.kodyId,
		publishedCommit: input.publishedCommit,
		skills: input.skills.map((skill) => ({
			name: skill.name,
			uriPrefix: [...skill.uriPrefix],
			uri: skill.uri,
			frontmatter: skill.frontmatter,
			skillRoot: skill.skillRoot,
			resources: skill.resources.map((resource) => ({
				relativePath: resource.relativePath,
				packagePath: resource.packagePath,
				uri: resource.uri,
				digest: resource.digest,
				size: resource.size,
				mimeType: resource.mimeType,
			})),
		})),
	}
}

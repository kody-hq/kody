import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Project lock written by vercel-labs/skills. `skills update` reinstalls every
 * entry whose sourceType is not `local`, which would replace this repo's
 * ship-pr policy with kentcdodds/kcd-skills. ship-pr stays local, and
 * computedHash is the folder hash of the committed skill.
 *
 * Skills-lock runs via `npm run deps:check` (and the CI static job) and as
 * `node tools/check-skills-lock.ts` on pre-push when the push changes this lock
 * or `.agents/skills/`. A skill edit that does not refresh computedHash fails
 * the check.
 */
export const skillsLockRelativePath = 'skills-lock.json'
export const shipPrSkillName = 'ship-pr'
export const shipPrLockSource = './.agents/skills/ship-pr'

const ignoredSkillDirectories = new Set(['.git', 'node_modules'])

export type SkillsLockCheckResult = {
	ok: boolean
	errors: Array<string>
}

type SkillsLockEntry = {
	source: string
	sourceType: string
	computedHash: string
	skillPath?: string
	sourceUrl?: string
	ref?: string
}

type SkillsLockFile = {
	version: number
	skills: Record<string, SkillsLockEntry>
}

/**
 * SHA-256 of a skill directory the way vercel-labs/skills local locks do:
 * sorted relative paths, each path's UTF-8 bytes, then the raw file bytes.
 * Skips `.git` and `node_modules` directories only.
 */
async function computeSkillFolderHash(skillDir: string): Promise<string> {
	const files: Array<{ relativePath: string; content: Buffer }> = []
	await collectSkillFiles(skillDir, skillDir, files)
	files.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	)
	const hash = createHash('sha256')
	for (const file of files) {
		hash.update(file.relativePath)
		hash.update(file.content)
	}
	return hash.digest('hex')
}

export async function checkSkillsLock(
	repoRoot: string,
): Promise<SkillsLockCheckResult> {
	const lockPath = path.join(repoRoot, skillsLockRelativePath)
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(lockPath, 'utf8'))
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			errors: [`Cannot read ${skillsLockRelativePath}: ${detail}`],
		}
	}

	const lock = parseSkillsLock(parsed)
	if (!lock) {
		return {
			ok: false,
			errors: [
				`${skillsLockRelativePath} must be a version 1 lock with a skills object.`,
			],
		}
	}

	const errors: Array<string> = []
	const shipPr = lock.skills[shipPrSkillName]
	if (!shipPr) {
		errors.push(
			`${skillsLockRelativePath} is missing ${shipPrSkillName}. Record it as a repo-owned skill (source ${shipPrLockSource}, sourceType local) with the folder hash of ${shipPrLockSource}.`,
		)
	} else {
		errors.push(...shipPrOwnershipErrors(shipPr))
	}

	for (const [name, entry] of Object.entries(lock.skills)) {
		const skillDir = skillDirectory(repoRoot, name, entry)
		if (!skillDir) {
			errors.push(
				`${skillsLockRelativePath} skills.${name}.source ${JSON.stringify(entry.source)} escapes the repository.`,
			)
			continue
		}
		let actualHash: string
		try {
			actualHash = await computeSkillFolderHash(skillDir)
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			errors.push(
				`Cannot hash ${path.relative(repoRoot, skillDir)} for skills.${name}: ${detail}`,
			)
			continue
		}
		if (actualHash !== entry.computedHash) {
			const relativeDir = path.relative(repoRoot, skillDir)
			errors.push(
				`${skillsLockRelativePath} skills.${name}.computedHash is ${entry.computedHash} but ${relativeDir} hashes to ${actualHash}. Update computedHash from the committed skill folder.`,
			)
		}
	}

	return { ok: errors.length === 0, errors }
}

function shipPrOwnershipErrors(entry: SkillsLockEntry): Array<string> {
	const errors: Array<string> = []
	if (entry.sourceType !== 'local' || entry.source !== shipPrLockSource) {
		errors.push(
			`${skillsLockRelativePath} skills.${shipPrSkillName} must be repo-owned (source ${JSON.stringify(shipPrLockSource)}, sourceType "local") so skills update does not reinstall it from kentcdodds/kcd-skills.`,
		)
	}
	if (
		entry.skillPath !== undefined ||
		entry.sourceUrl !== undefined ||
		entry.ref !== undefined
	) {
		errors.push(
			`${skillsLockRelativePath} skills.${shipPrSkillName} must not record skillPath, sourceUrl, or ref. Those fields mark an upstream install that skills update will refresh.`,
		)
	}
	return errors
}

function skillDirectory(
	repoRoot: string,
	name: string,
	entry: SkillsLockEntry,
): string | null {
	if (name === shipPrSkillName) {
		return path.join(repoRoot, '.agents', 'skills', shipPrSkillName)
	}
	if (entry.sourceType === 'local') {
		return resolveInsideRepo(repoRoot, entry.source)
	}
	return path.join(repoRoot, '.agents', 'skills', name)
}

function resolveInsideRepo(repoRoot: string, source: string): string | null {
	const absolute = path.resolve(repoRoot, source)
	const relative = path.relative(repoRoot, absolute)
	if (
		relative === '' ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return null
	}
	return absolute
}

function parseSkillsLock(value: unknown): SkillsLockFile | null {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) {
		return null
	}
	const skills: Record<string, SkillsLockEntry> = {}
	for (const [name, entry] of Object.entries(value.skills)) {
		const parsed = parseSkillsLockEntry(entry)
		if (!parsed) return null
		skills[name] = parsed
	}
	return { version: 1, skills }
}

function parseSkillsLockEntry(value: unknown): SkillsLockEntry | null {
	if (!isRecord(value)) return null
	if (typeof value.source !== 'string' || value.source.length === 0) return null
	if (typeof value.sourceType !== 'string' || value.sourceType.length === 0) {
		return null
	}
	if (
		typeof value.computedHash !== 'string' ||
		value.computedHash.length === 0
	) {
		return null
	}
	const entry: SkillsLockEntry = {
		source: value.source,
		sourceType: value.sourceType,
		computedHash: value.computedHash,
	}
	if (value.skillPath !== undefined) {
		if (typeof value.skillPath !== 'string') return null
		entry.skillPath = value.skillPath
	}
	if (value.sourceUrl !== undefined) {
		if (typeof value.sourceUrl !== 'string') return null
		entry.sourceUrl = value.sourceUrl
	}
	if (value.ref !== undefined) {
		if (typeof value.ref !== 'string') return null
		entry.ref = value.ref
	}
	return entry
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function collectSkillFiles(
	baseDir: string,
	currentDir: string,
	results: Array<{ relativePath: string; content: Buffer }>,
): Promise<void> {
	const entries = await readdir(currentDir, { withFileTypes: true })
	await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(currentDir, entry.name)
			if (entry.isDirectory()) {
				if (ignoredSkillDirectories.has(entry.name)) return
				await collectSkillFiles(baseDir, fullPath, results)
				return
			}
			if (!entry.isFile()) return
			const content = await readFile(fullPath)
			const relativePath = path
				.relative(baseDir, fullPath)
				.split('\\')
				.join('/')
			results.push({ relativePath, content })
		}),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await checkSkillsLock(process.cwd())
	if (!result.ok) {
		for (const error of result.errors) {
			console.error(error)
		}
		process.exitCode = 1
	}
}

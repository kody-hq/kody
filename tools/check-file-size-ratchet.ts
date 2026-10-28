import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { format, type FormatConfig, type OxfmtConfig } from 'oxfmt'
import oxfmtConfig from '../oxfmt.config.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultSnapshotRelativePath = path.join(
	'tools',
	'file-size-ratchet.json',
)

export type FileSizeRatchetGroupId =
	| 'agents-md'
	| 'client-routes'
	| 'node-tests'

export type FileSizeRatchetGroup = {
	id: FileSizeRatchetGroupId
	description: string
	maxLines: number
}

export const fileSizeRatchetGroups: ReadonlyArray<FileSizeRatchetGroup> = [
	{
		id: 'agents-md',
		description: 'AGENTS.md',
		// Reversible: raise this deliberately when the map must grow; do not
		// grandfather AGENTS.md via the snapshot allowlist.
		// 23: production-deploy rule for agents (#4242).
		maxLines: 23,
	},
	{
		id: 'client-routes',
		description: 'packages/worker/client/routes/*.tsx',
		maxLines: 800,
	},
	{
		id: 'node-tests',
		description: '*.node.test.ts',
		maxLines: 2000,
	},
]

export type FileSizeRatchetSnapshot = {
	[K in FileSizeRatchetGroupId]: Array<string>
}

export type FileSizeRatchetIssue = {
	groupId: FileSizeRatchetGroupId
	file: string
	lineCount: number
	maxLines: number
	kind: 'new-over-budget' | 'stale-snapshot'
}

export type FileSizeRatchetResult = {
	ok: boolean
	issues: Array<FileSizeRatchetIssue>
	underBudgetSnapshotEntries: Array<{
		groupId: FileSizeRatchetGroupId
		file: string
		lineCount: number
		maxLines: number
	}>
}

/**
 * Formats source the same way pre-commit / CI expect before line budgets are
 * counted. Injected in unit tests; production uses repo oxfmt config.
 */
export type FormatSourceForRatchet = (
	relativePath: string,
	sourceText: string,
) => Promise<string>

const skipDirectoryNames = new Set([
	'.git',
	'.wrangler',
	'build',
	'dist',
	'node_modules',
	'playwright-report',
	'test-results',
])

export function countLines(content: string) {
	if (content.length === 0) return 0
	const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
	if (normalized.length === 0) return 1
	return normalized.split('\n').length
}

export function formatOptionsFromOxfmtConfig(
	config: OxfmtConfig & { $schema?: unknown },
): FormatConfig {
	const {
		ignorePatterns: _ignorePatterns,
		overrides: _overrides,
		$schema: _schema,
		...options
	} = config
	return options
}

const defaultFormatOptions = formatOptionsFromOxfmtConfig(oxfmtConfig)

export async function formatSourceWithRepoOxfmt(
	relativePath: string,
	sourceText: string,
	options: FormatConfig = defaultFormatOptions,
): Promise<string> {
	const result = await format(relativePath, sourceText, options)
	const errors = result.errors.filter((error) => error.severity === 'Error')
	if (errors.length > 0) {
		const messages = errors.map((error) => error.message).join('; ')
		throw new Error(
			`Oxfmt failed to format ${relativePath} (${messages}). File-size ratchet counts lines after a successful format only.`,
		)
	}
	return result.code
}

export function parseFileSizeRatchetSnapshot(
	raw: string,
): FileSizeRatchetSnapshot {
	const parsed: unknown = JSON.parse(raw)
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('file-size ratchet snapshot must be an object')
	}
	const snapshot = parsed as Record<string, unknown>
	const result = {} as FileSizeRatchetSnapshot
	for (const group of fileSizeRatchetGroups) {
		const value = snapshot[group.id]
		if (
			!Array.isArray(value) ||
			value.some((entry) => typeof entry !== 'string')
		) {
			throw new Error(
				`file-size ratchet snapshot.${group.id} must be an array of paths`,
			)
		}
		result[group.id] = [...value].sort()
	}
	return result
}

async function collectMatchingFiles(
	cwd: string,
	directory: string,
	predicate: (relativePath: string) => boolean,
): Promise<Array<string>> {
	const matches: Array<string> = []
	const root = path.join(cwd, directory)
	const stack = [root]
	while (stack.length > 0) {
		const current = stack.pop()
		if (!current) continue
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === 'ENOENT' &&
				current === root
			) {
				return []
			}
			throw error
		}
		for (const entry of entries) {
			const absolutePath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				if (skipDirectoryNames.has(entry.name)) continue
				stack.push(absolutePath)
				continue
			}
			if (!entry.isFile()) continue
			const relativePath = path
				.relative(cwd, absolutePath)
				.replaceAll('\\', '/')
			if (predicate(relativePath)) matches.push(relativePath)
		}
	}
	return matches.sort()
}

export async function listRatchetGroupFiles(
	cwd: string,
	groupId: FileSizeRatchetGroupId,
): Promise<Array<string>> {
	switch (groupId) {
		case 'agents-md':
			return ['AGENTS.md']
		case 'client-routes':
			return collectMatchingFiles(
				cwd,
				path.join('packages', 'worker', 'client', 'routes'),
				(relativePath) =>
					/^packages\/worker\/client\/routes\/[^/]+\.tsx$/.test(relativePath),
			)
		case 'node-tests':
			return collectMatchingFiles(cwd, '.', (relativePath) =>
				relativePath.endsWith('.node.test.ts'),
			)
		default: {
			const _exhaustive: never = groupId
			throw new Error(`unknown file-size ratchet group: ${String(_exhaustive)}`)
		}
	}
}

export async function checkFileSizeRatchet(
	cwd: string,
	snapshot: FileSizeRatchetSnapshot,
	formatSource: FormatSourceForRatchet = formatSourceWithRepoOxfmt,
): Promise<FileSizeRatchetResult> {
	const issues: Array<FileSizeRatchetIssue> = []
	const underBudgetSnapshotEntries: FileSizeRatchetResult['underBudgetSnapshotEntries'] =
		[]

	for (const group of fileSizeRatchetGroups) {
		const files = await listRatchetGroupFiles(cwd, group.id)
		const allowlist = new Set(snapshot[group.id])
		const existing = new Set(files)

		for (const relativePath of files) {
			const raw = await readFile(path.join(cwd, relativePath), 'utf8')
			// Budget matches CI's formatted tree: count after oxfmt, not the
			// pre-format working tree (joined lines can expand on commit).
			const lineCount = countLines(await formatSource(relativePath, raw))
			if (lineCount <= group.maxLines) {
				if (allowlist.has(relativePath)) {
					underBudgetSnapshotEntries.push({
						groupId: group.id,
						file: relativePath,
						lineCount,
						maxLines: group.maxLines,
					})
				}
				continue
			}
			// AGENTS.md must never be grandfathered via the snapshot allowlist.
			if (group.id !== 'agents-md' && allowlist.has(relativePath)) continue
			issues.push({
				groupId: group.id,
				file: relativePath,
				lineCount,
				maxLines: group.maxLines,
				kind: 'new-over-budget',
			})
		}

		for (const relativePath of snapshot[group.id]) {
			if (existing.has(relativePath)) continue
			issues.push({
				groupId: group.id,
				file: relativePath,
				lineCount: 0,
				maxLines: group.maxLines,
				kind: 'stale-snapshot',
			})
		}
	}

	return {
		ok: issues.length === 0,
		issues,
		underBudgetSnapshotEntries,
	}
}

function formatIssues(issues: ReadonlyArray<FileSizeRatchetIssue>) {
	return issues
		.map((issue) => {
			if (issue.kind === 'stale-snapshot') {
				return `${issue.file} is listed in the ${issue.groupId} snapshot but no longer exists. Remove it from ${defaultSnapshotRelativePath}.`
			}
			if (issue.groupId === 'agents-md') {
				return `${issue.file} has ${String(issue.lineCount)} lines after formatting (budget ${String(issue.maxLines)}). Keep AGENTS.md a map; put detail in docs/contributing or .agents/skills. Raise the agents-md maxLines in tools/check-file-size-ratchet.ts only when the map must grow on purpose.`
			}
			return `${issue.file} has ${String(issue.lineCount)} lines after formatting (budget ${String(issue.maxLines)}). Split it or add it to ${defaultSnapshotRelativePath} only when shrinking an existing grandfathered file is impossible.`
		})
		.join('\n')
}

export async function loadFileSizeRatchetSnapshot(
	cwd: string,
	snapshotRelativePath: string = defaultSnapshotRelativePath,
): Promise<FileSizeRatchetSnapshot> {
	return parseFileSizeRatchetSnapshot(
		await readFile(path.join(cwd, snapshotRelativePath), 'utf8'),
	)
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const snapshot = await loadFileSizeRatchetSnapshot(cwd)
	const result = await checkFileSizeRatchet(cwd, snapshot)
	if (!result.ok) {
		console.error(
			[
				`File-size ratchet failed (${String(result.issues.length)} issue(s)).`,
				'AGENTS.md stays at or under the agents-md budget after formatting (raise maxLines only on purpose). Client routes stay at or under 800 lines after formatting unless they are already in the snapshot. Node tests stay at or under 2000 lines after formatting unless they are already in the snapshot. The snapshot is an allowlist of existing oversized files; it must not grow except to record a file that was already over budget, and AGENTS.md must not be grandfathered there.',
				'',
				formatIssues(result.issues),
			].join('\n'),
		)
		process.exitCode = 1
		return
	}
	if (result.underBudgetSnapshotEntries.length > 0) {
		console.log(
			[
				'File-size ratchet passed.',
				'These snapshot entries are now under budget and can be removed:',
				...result.underBudgetSnapshotEntries.map(
					(entry) =>
						`- ${entry.file} (${String(entry.lineCount)} / ${String(entry.maxLines)})`,
				),
			].join('\n'),
		)
		return
	}
	console.log('File-size ratchet passed.')
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}

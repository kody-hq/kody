import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
	isBaseBranchCheckout,
	mustYieldMigrationPrefix,
	resolveTrustedMigrationBase,
	shouldEnforceOpenPullRequestOverlaps,
	suggestFreeMigrationPrefix,
} from './check-migrations.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	resolveCurrentPullNumber,
	formatOversizedPullRequestsWarning,
	scanOpenPullRequestFiles,
	type OpenPullRequestFileScan,
} from './open-pull-request-migration-prefixes.ts'

export const defaultDecisionsDir = path.join(
	'docs',
	'contributing',
	'decisions',
)
export const defaultDecisionIndexPath = path.join(
	defaultDecisionsDir,
	'index.md',
)

const decisionRecordFilenamePattern =
	/^(?<prefix>\d{4})-(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const decisionHeadingPrefixPattern = /^#\s+(\d{4})\b/
const decisionIndexLinkPattern = /\(\.\/(\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)\.md\)/g

export type DecisionRecordKind = 'primary' | 'lab'

export type DecisionRecordFile = {
	filename: string
	prefix: string
	slug: string
	kind: DecisionRecordKind
}

export type DecisionRecordNumberCheckResult = {
	ok: boolean
	errors: Array<string>
	records: Array<DecisionRecordFile>
}

export function classifyDecisionRecordFilename(
	filename: string,
): DecisionRecordFile | null {
	if (filename === '0000-template.md' || filename === 'index.md') {
		return null
	}
	const match = decisionRecordFilenamePattern.exec(filename)
	if (!match?.groups) {
		return null
	}
	const { prefix, slug } = match.groups
	if (prefix === undefined || slug === undefined) {
		return null
	}
	return {
		filename,
		prefix,
		slug,
		kind: slug.endsWith('-lab') ? 'lab' : 'primary',
	}
}

export function findDuplicatePrimaryPrefixes(
	records: ReadonlyArray<DecisionRecordFile>,
): Array<string> {
	const primaries = records.filter((record) => record.kind === 'primary')
	const filesByPrefix = new Map<string, Array<string>>()
	for (const record of primaries) {
		const files = filesByPrefix.get(record.prefix) ?? []
		files.push(record.filename)
		filesByPrefix.set(record.prefix, files)
	}
	return [...filesByPrefix.entries()]
		.filter(([, files]) => files.length > 1)
		.map(
			([prefix, files]) =>
				`Duplicate decision number ${prefix}: ${files.toSorted().join(', ')}. Renumber the later record; lab companions may share a number only as NNNN-*-lab.md.`,
		)
}

export function findOrphanLabCompanions(
	records: ReadonlyArray<DecisionRecordFile>,
): Array<string> {
	const primaryPrefixes = new Set(
		records
			.filter((record) => record.kind === 'primary')
			.map((record) => record.prefix),
	)
	return records
		.filter((record) => record.kind === 'lab')
		.filter((record) => !primaryPrefixes.has(record.prefix))
		.map(
			(record) =>
				`Lab companion ${record.filename} has no primary ${record.prefix}-*.md record.`,
		)
}

const openingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})/
const closingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})[ \t]*$/
const atxHeadingLinePattern = /^ {0,3}# /

type MarkdownFence = {
	character: string
	length: number
}

function parseFenceMarker(line: string, pattern: RegExp): MarkdownFence | null {
	const fence = pattern.exec(line)?.groups?.fence
	if (!fence) return null
	return {
		character: fence[0] ?? '',
		length: fence.length,
	}
}

export function findFirstMarkdownHeading(content: string): string | undefined {
	let openFence: MarkdownFence | null = null
	for (const line of content.split('\n')) {
		if (openFence) {
			const closingFence = parseFenceMarker(line, closingFencePattern)
			if (
				closingFence?.character === openFence.character &&
				closingFence.length >= openFence.length
			) {
				openFence = null
			}
			continue
		}
		const openingFence = parseFenceMarker(line, openingFencePattern)
		if (openingFence) {
			openFence = openingFence
			continue
		}
		if (atxHeadingLinePattern.test(line)) {
			return line.trim()
		}
	}
	return undefined
}

export function findHeadingPrefixMismatches(input: {
	filename: string
	prefix: string
	content: string
}): Array<string> {
	const firstHeading = findFirstMarkdownHeading(input.content)
	if (!firstHeading) {
		return [`${input.filename} is missing a top-level heading.`]
	}
	const headingPrefix = decisionHeadingPrefixPattern.exec(firstHeading)?.[1]
	if (headingPrefix !== input.prefix) {
		return [
			`${input.filename} heading number ${headingPrefix ?? '(none)'} does not match filename prefix ${input.prefix}.`,
		]
	}
	return []
}

export function findIndexPrimaryNumberCollisions(
	indexContent: string,
): Array<string> {
	const primaryLinksByPrefix = new Map<string, Set<string>>()
	for (const match of indexContent.matchAll(decisionIndexLinkPattern)) {
		const basename = match[1]
		if (!basename) continue
		const record = classifyDecisionRecordFilename(`${basename}.md`)
		if (!record || record.kind === 'lab') continue
		const files = primaryLinksByPrefix.get(record.prefix) ?? new Set()
		files.add(record.filename)
		primaryLinksByPrefix.set(record.prefix, files)
	}
	return [...primaryLinksByPrefix.entries()]
		.filter(([, files]) => files.size > 1)
		.map(
			([prefix, files]) =>
				`docs/contributing/decisions/index.md links two primary records as ${prefix}: ${[...files].toSorted().join(', ')}.`,
		)
}

export async function checkDecisionRecordNumbers(
	cwd: string = process.cwd(),
	decisionsDir: string = defaultDecisionsDir,
	indexPath: string = defaultDecisionIndexPath,
): Promise<DecisionRecordNumberCheckResult> {
	const decisionsRoot = path.join(cwd, decisionsDir)
	const entries = await readdir(decisionsRoot, { withFileTypes: true })
	const errors: Array<string> = []
	const records: Array<DecisionRecordFile> = []

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue
		if (entry.name === '0000-template.md' || entry.name === 'index.md') {
			continue
		}
		const record = classifyDecisionRecordFilename(entry.name)
		if (!record) {
			errors.push(
				`${path.join(decisionsDir, entry.name)} is not NNNN-kebab-slug.md (or NNNN-kebab-slug-lab.md).`,
			)
			continue
		}
		records.push(record)
		const content = await readFile(path.join(decisionsRoot, entry.name), 'utf8')
		errors.push(
			...findHeadingPrefixMismatches({
				filename: path.join(decisionsDir, entry.name),
				prefix: record.prefix,
				content,
			}),
		)
	}

	errors.push(...findDuplicatePrimaryPrefixes(records))
	errors.push(...findOrphanLabCompanions(records))
	const indexContent = await readFile(path.join(cwd, indexPath), 'utf8')
	errors.push(...findIndexPrimaryNumberCollisions(indexContent))

	return {
		ok: errors.length === 0,
		errors,
		records,
	}
}

export type OpenPullRequestDecisionOverlap = {
	prefix: string
	pullNumbers: Array<number>
}

export type OpenPullRequestDecisionAdvisory = {
	lines: Array<string>
	warning: string | null
	overlaps: Array<OpenPullRequestDecisionOverlap>
	/** Overlaps this checkout must give up: the lowest open PR number keeps a number. */
	blockingOverlaps: Array<OpenPullRequestDecisionOverlap>
	suggestedPrefix: string | null
}

/**
 * Compares the primary decision numbers this checkout adds (not in the trusted
 * base) with those other open pull requests add. Lab companions never claim.
 */
export function formatOpenPullRequestDecisionAdvisory(input: {
	records: ReadonlyArray<DecisionRecordFile>
	/** Decision filenames already on the trusted base; null when unknown. */
	baseFilenames: ReadonlySet<string> | null
	scan: OpenPullRequestFileScan
	currentPullNumber: number | null
	isBaseBranchCheckout: boolean
}): OpenPullRequestDecisionAdvisory {
	const empty = {
		lines: [],
		overlaps: [],
		blockingOverlaps: [],
		suggestedPrefix: null,
	}
	if (input.scan.status === 'skipped') {
		const silent =
			input.scan.reason === 'no-token' || input.scan.reason === 'no-repository'
		return {
			...empty,
			warning: silent
				? null
				: `Open pull request decision-number scan skipped: ${(input.scan.detail ?? input.scan.reason).replace(/\.+$/u, '')}.`,
		}
	}
	if (input.baseFilenames === null) {
		return {
			...empty,
			warning:
				'Open pull request decision-number check skipped: no trusted Git base to tell new records from existing ones.',
		}
	}
	const baseFilenames = input.baseFilenames
	const primaries = input.records.filter((record) => record.kind === 'primary')
	const newPrefixes = new Set(
		primaries
			.filter((record) => !baseFilenames.has(record.filename))
			.map((record) => record.prefix),
	)
	const claimsByPrefix = new Map<string, Set<number>>()
	for (const claim of input.scan.claims) {
		for (const filename of claim.filenames) {
			const record = classifyDecisionRecordFilename(
				path.posix.basename(filename),
			)
			if (record?.kind !== 'primary') continue
			const numbers = claimsByPrefix.get(record.prefix) ?? new Set<number>()
			numbers.add(claim.number)
			claimsByPrefix.set(record.prefix, numbers)
		}
	}
	const overlaps = [...newPrefixes].sort().flatMap((prefix) => {
		const numbers = claimsByPrefix.get(prefix)
		return numbers
			? [{ prefix, pullNumbers: [...numbers].sort((a, b) => a - b) }]
			: []
	})
	const blockingOverlaps = overlaps.filter((group) =>
		mustYieldMigrationPrefix({
			group,
			currentPullNumber: input.currentPullNumber,
			isBaseBranchCheckout: input.isBaseBranchCheckout,
		}),
	)
	const keptPrefixes = new Set(
		primaries
			.filter(
				(record) =>
					!blockingOverlaps.some((group) => group.prefix === record.prefix),
			)
			.map((record) => Number(record.prefix)),
	)
	const nextLocal = String(Math.max(0, ...keptPrefixes) + 1).padStart(4, '0')
	const currentPullNumber = input.currentPullNumber
	const rank =
		currentPullNumber === null
			? 1
			: Math.max(
					1,
					...blockingOverlaps.map(
						(group) =>
							group.pullNumbers.filter((number) => number < currentPullNumber)
								.length,
					),
				)
	const suggestedPrefix = suggestFreeMigrationPrefix({
		nextPrefix: nextLocal,
		claimedPrefixes: [...claimsByPrefix.keys()],
		rank,
	})
	const lines: Array<string> = []
	if (blockingOverlaps.length > 0) {
		lines.push(
			'Open pull requests already claim decision number(s) this checkout adds (the lowest PR number keeps a number):',
			...blockingOverlaps.map(
				(group) =>
					`  ${group.prefix}: ${group.pullNumbers.map((number) => `#${String(number)}`).join(', ')}`,
			),
			`Renumber to ${suggestedPrefix ?? 'a free number'}: rename the file, its heading, and its index.md entry.`,
		)
	}
	const kept = overlaps.filter((group) => !blockingOverlaps.includes(group))
	if (kept.length > 0) {
		lines.push(
			'Higher-numbered open pull requests reuse decision number(s) this checkout keeps; they must renumber:',
			...kept.map(
				(group) =>
					`  ${group.prefix}: ${group.pullNumbers.map((number) => `#${String(number)}`).join(', ')}`,
			),
		)
	}
	return {
		lines,
		warning: formatOversizedPullRequestsWarning(
			'Open pull request decision-number',
			input.scan.oversizedPullNumbers,
		),
		overlaps,
		blockingOverlaps,
		suggestedPrefix,
	}
}

function gitOutputIn(cwd: string, args: ReadonlyArray<string>) {
	try {
		return execFileSync('git', [...args], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		return null
	}
}

function listBaseDecisionFilenames(
	cwd: string,
	base: string,
	decisionsDir: string,
): Set<string> | null {
	const output = gitOutputIn(cwd, [
		'ls-tree',
		'--name-only',
		base,
		'--',
		`${decisionsDir.replaceAll(path.sep, '/')}/`,
	])
	if (output === null) return null
	return new Set(
		output
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => path.posix.basename(line)),
	)
}

async function readOpenPullRequestDecisionAdvisory(input: {
	cwd: string
	env: NodeJS.ProcessEnv
	records: ReadonlyArray<DecisionRecordFile>
}): Promise<OpenPullRequestDecisionAdvisory> {
	const baseBranchCheckout = isBaseBranchCheckout(input.env)
	const currentPullNumber = baseBranchCheckout
		? null
		: resolveCurrentPullNumber(input.env, input.cwd)
	const scan = await scanOpenPullRequestFiles({
		env: input.env,
		cwd: input.cwd,
		directory: defaultDecisionsDir,
		currentPullNumber,
		claimsFile: (file) =>
			file.status !== 'removed' &&
			classifyDecisionRecordFilename(file.basename)?.kind === 'primary',
	})
	const base =
		scan.status === 'ok'
			? await resolveTrustedMigrationBase({
					env: input.env,
					git: async (args) => gitOutputIn(input.cwd, args),
				})
			: null
	return formatOpenPullRequestDecisionAdvisory({
		records: input.records,
		baseFilenames: base
			? listBaseDecisionFilenames(input.cwd, base, defaultDecisionsDir)
			: null,
		scan,
		currentPullNumber,
		isBaseBranchCheckout: baseBranchCheckout,
	})
}

export async function main(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const result = await checkDecisionRecordNumbers(cwd)
	// Advisory only: missing GitHub auth or an API error must not fail the check.
	const advisory = await readOpenPullRequestDecisionAdvisory({
		cwd,
		env,
		records: result.records,
	})
	if (advisory.warning) console.warn(advisory.warning)
	if (result.ok) {
		if (
			advisory.blockingOverlaps.length > 0 &&
			shouldEnforceOpenPullRequestOverlaps(env)
		) {
			console.error(
				[
					'Decision-record number check failed: open pull requests claim the same number(s).',
					...advisory.lines,
				].join('\n'),
			)
			process.exitCode = 1
			return
		}
		console.log('Decision-record number check passed.')
		for (const line of advisory.lines) console.log(line)
		return
	}
	for (const line of advisory.lines) console.error(line)
	console.error(
		[
			`Decision-record number check failed (${String(result.errors.length)} issue(s)).`,
			'Each steering record needs a unique NNNN. Lab notes may share that number only as NNNN-*-lab.md.',
			'See docs/contributing/decisions/index.md.',
			'',
			...result.errors,
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}

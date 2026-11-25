/**
 * Parse fenced mermaid in docs, skills, and `--stdin` recap blocks the way
 * GitHub does, so invalid diagrams fail in `npm run validate` instead of as
 * "Unable to render rich display" on the PR.
 *
 * Usage:
 *   node tools/check-mermaid-syntax.ts
 *   node tools/check-mermaid-syntax.ts path/to/file.md
 *   node tools/check-mermaid-syntax.ts --stdin [--label recap.md]
 */
import { readdir, readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type MermaidFence = {
	source: string
	startLine: number
	code: string
	closed: boolean
}

export type MermaidSyntaxIssue = {
	file: string
	line: number
	message: string
}

type MermaidApi = {
	initialize: (config: { startOnLoad: boolean; logLevel: string }) => void
	parse: (text: string) => Promise<{ diagramType: string }>
	detectType: (text: string) => string
}

const mermaidInfoPattern = /^mermaid(?:$|\s)/i
const mermaidErrorLinePattern = /\bon line (\d+)\b/i
const openingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})(?<info>.*)$/
const closingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})[ \t]*$/

let mermaidApiPromise: Promise<MermaidApi> | undefined
let dompurifyStubInstalled = false

/**
 * mermaid.parse() sanitizes flowchart (and some other) labels with DOMPurify.
 * Node has no `window`, so the real DOMPurify build has no `sanitize`. This
 * checker only needs syntax, so stub DOMPurify before mermaid loads.
 */
function installDompurifyStubForNodeParse(): void {
	if (dompurifyStubInstalled) {
		return
	}
	registerHooks({
		load(url, context, nextLoad) {
			if (!new URL(url).pathname.includes('/node_modules/dompurify/')) {
				return nextLoad(url, context)
			}
			return {
				format: 'module',
				shortCircuit: true,
				source: `
const purify = {
	sanitize(text) {
		return String(text ?? '')
	},
	addHook() {},
	removeHook() {},
	removeHooks() {},
	removeAllHooks() {},
	isSupported: true,
}
export default purify
`,
			}
		},
	})
	dompurifyStubInstalled = true
}

async function loadMermaid(): Promise<MermaidApi> {
	installDompurifyStubForNodeParse()
	mermaidApiPromise ??= import('mermaid').then((module) => {
		const api = module.default as MermaidApi
		api.initialize({ startOnLoad: false, logLevel: 'fatal' })
		return api
	})
	return mermaidApiPromise
}

function isMermaidInfo(info: string): boolean {
	return mermaidInfoPattern.test(info.trim())
}

function formatUnknownError(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== '') {
		return error.message
	}
	return String(error)
}

export function mermaidErrorLine(message: string): number | undefined {
	const match = mermaidErrorLinePattern.exec(message)
	if (!match?.[1]) {
		return undefined
	}
	const line = Number(match[1])
	return Number.isInteger(line) && line > 0 ? line : undefined
}

export function summarizeMermaidError(message: string): string {
	const lines = message.split('\n').map((line) => line.trim())
	const first = lines[0] || message
	const snippet = lines[1]
	const got = /got '[^']+'/.exec(message)?.[0]
	return [first, snippet, got].filter(Boolean).join(' ')
}

export function extractFencedMermaidBlocks(input: {
	source: string
	content: string
}): Array<MermaidFence> {
	const lines = input.content.split(/\r?\n/)
	const blocks: Array<MermaidFence> = []

	for (let index = 0; index < lines.length; index += 1) {
		const opening = openingFencePattern.exec(lines[index] ?? '')
		const fence = opening?.groups?.fence
		if (!fence || !isMermaidInfo(opening?.groups?.info ?? '')) {
			continue
		}

		const fenceCharacter = fence[0]
		const fenceLength = fence.length
		const startLine = index + 1
		const body: Array<string> = []
		let closed = false
		index += 1

		while (index < lines.length) {
			const bodyLine = lines[index] ?? ''
			const closingFence = closingFencePattern.exec(bodyLine)?.groups?.fence
			if (
				closingFence &&
				closingFence[0] === fenceCharacter &&
				closingFence.length >= fenceLength
			) {
				closed = true
				break
			}
			body.push(bodyLine)
			index += 1
		}

		blocks.push({
			source: input.source,
			startLine,
			code: body.join('\n'),
			closed,
		})
		if (!closed) {
			break
		}
	}

	return blocks
}

export async function parseMermaidDiagram(
	code: string,
): Promise<
	| { ok: true; diagramType: string }
	| { ok: false; message: string; mermaidLine?: number }
> {
	const trimmed = code.trim()
	if (trimmed === '') {
		return { ok: false, message: 'Empty mermaid diagram' }
	}

	const mermaid = await loadMermaid()
	try {
		const result = await mermaid.parse(trimmed)
		return { ok: true, diagramType: result.diagramType }
	} catch (error) {
		const message = formatUnknownError(error)
		return {
			ok: false,
			message,
			mermaidLine: mermaidErrorLine(message),
		}
	}
}

export async function looksLikeRawMermaid(content: string): Promise<boolean> {
	const trimmed = content.trim()
	if (trimmed === '') {
		return false
	}
	const mermaid = await loadMermaid()
	try {
		mermaid.detectType(trimmed)
		return true
	} catch {
		return false
	}
}

function issueFromFence(
	fence: MermaidFence,
	message: string,
	mermaidLine?: number,
): MermaidSyntaxIssue {
	return {
		file: fence.source,
		line:
			mermaidLine === undefined
				? fence.startLine
				: fence.startLine + mermaidLine,
		message,
	}
}

export async function checkMermaidMarkdown(input: {
	source: string
	content: string
}): Promise<Array<MermaidSyntaxIssue>> {
	const fences = extractFencedMermaidBlocks(input)
	if (fences.length === 0) {
		if (!(await looksLikeRawMermaid(input.content))) {
			return []
		}
		const parsed = await parseMermaidDiagram(input.content)
		if (parsed.ok) {
			return []
		}
		return [
			{
				file: input.source,
				line: parsed.mermaidLine ?? 1,
				message: parsed.message,
			},
		]
	}

	const issues: Array<MermaidSyntaxIssue> = []
	for (const fence of fences) {
		if (!fence.closed) {
			issues.push(issueFromFence(fence, 'Unclosed mermaid fence'))
			continue
		}
		const parsed = await parseMermaidDiagram(fence.code)
		if (parsed.ok) {
			continue
		}
		issues.push(issueFromFence(fence, parsed.message, parsed.mermaidLine))
	}
	return issues
}

async function collectMatchingPaths(
	directory: string,
	relativePrefix: string,
	filePattern: RegExp,
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const paths: Array<string> = []

	for (const entry of entries) {
		const relativePath = `${relativePrefix}/${entry.name}`
		const absolutePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			paths.push(
				...(await collectMatchingPaths(
					absolutePath,
					relativePath,
					filePattern,
				)),
			)
		} else if (entry.isFile() && filePattern.test(entry.name)) {
			paths.push(relativePath.replaceAll('\\', '/'))
		}
	}

	return paths
}

export async function listMermaidSourcePaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths = ['README.md', 'AGENTS.md']
	for (const root of ['docs', '.agents']) {
		paths.push(
			...(await collectMatchingPaths(
				path.join(cwd, root),
				root,
				/\.(md|mdx)$/,
			)),
		)
	}
	return [...new Set(paths)].sort()
}

export async function checkMermaidSyntax(
	cwd: string = process.cwd(),
	relativePaths?: ReadonlyArray<string>,
): Promise<Array<MermaidSyntaxIssue>> {
	const paths =
		relativePaths !== undefined && relativePaths.length > 0
			? relativePaths
			: await listMermaidSourcePaths(cwd)
	const issues: Array<MermaidSyntaxIssue> = []

	for (const relativePath of paths) {
		issues.push(
			...(await checkMermaidMarkdown({
				source: relativePath.replaceAll('\\', '/'),
				// path.resolve keeps relative paths under cwd and accepts
				// absolute paths (for example /tmp/pr-body.md before upsert).
				content: await readFile(path.resolve(cwd, relativePath), 'utf8'),
			})),
		)
	}

	return issues
}

function formatIssues(issues: ReadonlyArray<MermaidSyntaxIssue>): string {
	return issues
		.map(
			(issue) =>
				`${issue.file}:${String(issue.line)}: ${summarizeMermaidError(issue.message)}`,
		)
		.join('\n')
}

type CliOptions = {
	stdin: boolean
	label: string
	files: Array<string>
}

export function parseMermaidCheckArgs(
	argv: ReadonlyArray<string>,
): CliOptions | { error: string } {
	const files: Array<string> = []
	let stdin = false
	let label = '<stdin>'

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--stdin') {
			stdin = true
			continue
		}
		if (arg === '--label') {
			const value = argv[index + 1]
			if (!value || value.startsWith('--')) {
				return { error: 'missing value for --label' }
			}
			label = value
			index += 1
			continue
		}
		if (arg?.startsWith('--')) {
			return { error: `unknown flag ${arg}` }
		}
		if (arg) {
			files.push(arg)
		}
	}

	if (stdin && files.length > 0) {
		return { error: 'use either --stdin or file paths, not both' }
	}

	return { stdin, label, files }
}

async function readStdin(
	stdin: AsyncIterable<string | Buffer>,
): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stdin) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function reportIssues(issues: ReadonlyArray<MermaidSyntaxIssue>): void {
	if (issues.length === 0) {
		console.log('Mermaid syntax check passed.')
		return
	}

	console.error(
		[
			`Mermaid syntax check failed (${String(issues.length)} issue(s)).`,
			'GitHub cannot render invalid mermaid. Sequence notes and messages treat `;` as the end of the statement — leftover tokens (often `+`) then fail to parse.',
			'See docs/contributing/documentation.md.',
			'',
			formatIssues(issues),
		].join('\n'),
	)
	process.exitCode = 1
}

export async function main(
	argv: ReadonlyArray<string> = process.argv.slice(2),
	cwd: string = process.cwd(),
	stdin: AsyncIterable<string | Buffer> = process.stdin,
): Promise<void> {
	const options = parseMermaidCheckArgs(argv)
	if ('error' in options) {
		console.error(options.error)
		process.exitCode = 1
		return
	}

	if (options.stdin) {
		reportIssues(
			await checkMermaidMarkdown({
				source: options.label,
				content: await readStdin(stdin),
			}),
		)
		return
	}

	reportIssues(
		await checkMermaidSyntax(
			cwd,
			options.files.length === 0 ? undefined : options.files,
		),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}

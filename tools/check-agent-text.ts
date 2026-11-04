import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type AgentTextMatch = {
	file: string
	line: number
	column: number
	rule: string
	fix: string
	excerpt: string
}

type AgentTextRule = {
	id: string
	regex: RegExp
	fix: string
}

/**
 * Agent skills and the agent map. Rules here replace style lines that
 * skills used to restate.
 */
export const scannedRelativePrefixes: ReadonlyArray<string> = [
	'.agents/skills/',
]

export const scannedRelativeFiles: ReadonlyArray<string> = ['AGENTS.md']

export const agentTextRules: ReadonlyArray<AgentTextRule> = [
	{
		id: 'em-dash',
		regex: /\u2014/g,
		fix: 'Replace the em dash with a period, comma, colon, or parentheses.',
	},
	{
		id: 'kody-token-value',
		regex: /\bkody_(?:at|bc)_[A-Za-z0-9]{8,}/g,
		fix: 'Remove the token value. Name the credential or use a placeholder such as `kody_bc_…`.',
	},
	{
		id: 'secret-placeholder-syntax',
		regex:
			/\{\{\s*secrets?\.[^}]*\}\}|\$\{\s*secret:[^}]*\}|\{\{\s+secret:[^}]*\}\}/g,
		fix: 'Kody secret placeholders are written `{{secret:<name>}}` (no spaces, no `secrets.` or `${…}` form).',
	},
]

function isScannedRelativePath(relativePath: string): boolean {
	const normalized = relativePath.replaceAll('\\', '/')
	if (scannedRelativeFiles.includes(normalized)) return true
	return scannedRelativePrefixes.some((prefix) => normalized.startsWith(prefix))
}

export function findAgentTextViolations(input: {
	relativePath: string
	content: string
}): Array<AgentTextMatch> {
	const relativePath = input.relativePath.replaceAll('\\', '/')
	if (!isScannedRelativePath(relativePath)) return []
	const matches: Array<AgentTextMatch> = []
	const lines = input.content.split('\n')
	for (const [index, line] of lines.entries()) {
		for (const rule of agentTextRules) {
			rule.regex.lastIndex = 0
			for (const match of line.matchAll(rule.regex)) {
				matches.push({
					file: relativePath,
					line: index + 1,
					column: (match.index ?? 0) + 1,
					rule: rule.id,
					fix: rule.fix,
					excerpt: line.trim(),
				})
			}
		}
	}
	return matches
}

async function collectMarkdown(
	directory: string,
	relativePrefix: string,
): Promise<Array<string>> {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (
			error &&
			typeof error === 'object' &&
			'code' in error &&
			error.code === 'ENOENT'
		) {
			return []
		}
		throw error
	}
	const paths: Array<string> = []
	for (const entry of entries) {
		const relativePath = `${relativePrefix}${entry.name}`
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			paths.push(
				...(await collectMarkdown(
					path.join(directory, entry.name),
					`${relativePath}/`,
				)),
			)
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			paths.push(relativePath)
		}
	}
	return paths
}

export async function listAgentTextScanPaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths: Array<string> = [...scannedRelativeFiles]
	for (const prefix of scannedRelativePrefixes) {
		paths.push(...(await collectMarkdown(path.join(cwd, prefix), prefix)))
	}
	return paths.sort()
}

export async function checkAgentText(
	cwd: string = process.cwd(),
): Promise<Array<AgentTextMatch>> {
	const matches: Array<AgentTextMatch> = []
	for (const relativePath of await listAgentTextScanPaths(cwd)) {
		let content: string
		try {
			content = await readFile(path.join(cwd, relativePath), 'utf8')
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				continue
			}
			throw error
		}
		matches.push(...findAgentTextViolations({ relativePath, content }))
	}
	return matches
}

if (isExecutedDirectly(import.meta.url)) {
	const matches = await checkAgentText()
	if (matches.length > 0) {
		for (const match of matches) {
			console.error(
				`${match.file}:${match.line}:${match.column} [${match.rule}] ${match.fix}\n  ${match.excerpt}`,
			)
		}
		console.error(
			`\ncheck-agent-text: ${matches.length} problem(s) in agent skills or AGENTS.md.`,
		)
		process.exit(1)
	}
	console.log('check-agent-text: ok')
}

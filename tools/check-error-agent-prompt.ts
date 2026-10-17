import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { cwd as processCwd, exit } from 'node:process'
import {
	errorAgentPromptAdoptFiles,
	errorAgentPromptCandidatePatterns,
	errorAgentPromptMarker,
	errorAgentPromptSkipFiles,
} from './error-agent-prompt-surfaces.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const skipDirNames = new Set([
	'.git',
	'.generated',
	'.tmp',
	'.wrangler',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'tmp',
])

function walkFiles(root: string, out: Array<string>) {
	let entries: Array<string>
	try {
		entries = readdirSync(root)
	} catch {
		return
	}
	for (const entry of entries) {
		if (skipDirNames.has(entry)) continue
		const full = path.join(root, entry)
		let st
		try {
			st = statSync(full)
		} catch {
			continue
		}
		if (st.isDirectory()) {
			walkFiles(full, out)
			continue
		}
		if (!/\.(?:[cm]?[jt]sx?)$/.test(entry)) continue
		if (/\.(?:test|spec)\./.test(entry)) continue
		out.push(full)
	}
}

function repoRelative(filePath: string, cwd: string) {
	return path.relative(cwd, filePath).replaceAll('\\', '/')
}

export function checkErrorAgentPromptSurfaces(cwd = processCwd()) {
	const issues: Array<string> = []
	const adoptSet = new Set<string>(errorAgentPromptAdoptFiles)
	const skipSet = new Set(errorAgentPromptSkipFiles.map((entry) => entry.file))

	for (const relative of errorAgentPromptAdoptFiles) {
		const absolute = path.join(cwd, relative)
		let source: string
		try {
			source = readFileSync(absolute, 'utf8')
		} catch {
			issues.push(`adopt surface missing on disk: ${relative}`)
			continue
		}
		const usesPrimitive =
			source.includes(errorAgentPromptMarker) ||
			/error-agent-prompt(?:-button|-presets)?(?:\.tsx?)?['"]/.test(source)
		if (!usesPrimitive) {
			issues.push(
				`${relative} is listed as an agent-blind error surface but does not import the error-agent-prompt primitive or stamp "${errorAgentPromptMarker}". Import buildErrorAgentPrompt / ErrorAgentPromptButton / renderErrorAgentPromptStaticHtml and stamp the marker.`,
			)
		}
	}

	const files: Array<string> = []
	walkFiles(path.join(cwd, 'packages/worker'), files)
	for (const absolute of files) {
		const relative = repoRelative(absolute, cwd)
		if (adoptSet.has(relative) || skipSet.has(relative)) continue
		if (
			!errorAgentPromptCandidatePatterns.some((pattern) =>
				pattern.test(relative),
			)
		) {
			continue
		}
		issues.push(
			`${relative} looks like a dedicated error page but is not in tools/error-agent-prompt-surfaces.ts adopt or skip. Classify it: adopt + use the error-agent-prompt primitive, or skip with a reason.`,
		)
	}

	return issues
}

function main() {
	const issues = checkErrorAgentPromptSurfaces()
	if (issues.length > 0) {
		console.error(
			`error-agent-prompt guard failed (${String(issues.length)} issue(s)):`,
		)
		for (const issue of issues) console.error(`- ${issue}`)
		exit(1)
	}
	console.log(
		`error-agent-prompt guard passed (${String(errorAgentPromptAdoptFiles.length)} adopt surfaces).`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}

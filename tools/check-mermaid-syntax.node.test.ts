import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	checkMermaidMarkdown,
	checkMermaidSyntax,
	extractFencedMermaidBlocks,
	listMermaidSourcePaths,
	parseMermaidCheckArgs,
	parseMermaidDiagram,
} from './check-mermaid-syntax.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const githubPlusNoteDiagram = [
	'sequenceDiagram',
	'  actor Caller',
	'  participant vite as Vite',
	'  participant appUi as app-ui',
	'  participant originWorker as origin worker',
	'  Caller->>vite: vite serve or vite build',
	'  vite->>appUi: transform clientEntry(import.meta.url) and ?assets=',
	'  Note over vite: serve writes origin local-dev vars; jobs+highlight stay in test',
	'  vite->>originWorker: SSR entry from Wrangler main',
	'  Caller->>originWorker: GET HTML route',
	'  originWorker->>appUi: resolveClientEntry to hashed /assets/entry-*.js',
	'  appUi-->>Caller: data-rmx-* document plus /assets/* modules',
].join('\n')

const githubPlusNoteFixed = githubPlusNoteDiagram.replace(
	'Note over vite: serve writes origin local-dev vars; jobs+highlight stay in test',
	'Note over vite: serve writes origin local-dev vars, jobs and highlight stay in test',
)

const visualRecapSequence = [
	'sequenceDiagram',
	'\tactor User',
	'\tparticipant appUi as app-ui',
	'\tparticipant appSessions as app-sessions',
	'\tparticipant rbac as rbac',
	'\tparticipant d1AppDb as d1-app-db',
	'\tUser->>appUi: click provider button',
	'\tappUi->>appSessions: POST /auth/:provider',
	'\tappSessions->>rbac: 2FA gate on sign-in',
	'\tappSessions->>d1AppDb: insert oauth_connections',
	'\tNote over d1AppDb: new table is an export + deletion target',
].join('\n')

const visualRecapFlowchart = [
	'flowchart LR',
	'\tappUi["app-ui<br/>Browser app"]:::touched',
	'\tappSessions["app-sessions<br/>Browser sessions"]:::extended',
	'\td1AppDb["d1-app-db<br/>D1 app database"]:::extended',
	'\taccountExport["account-export<br/>Account data export"]:::extended',
	'\trbac["rbac<br/>Role-based access control"]:::untouched',
	'\tappUi -->|"POST /auth/:provider buttons"| appSessions',
	'\tappSessions -->|"oauth_connections table"| d1AppDb',
	'\tappSessions -->|"2FA gate on sign-in"| rbac',
	'\taccountExport -->|"export + deletion targets"| d1AppDb',
	'\tclassDef touched fill:#1a7f37,color:#fff',
	'\tclassDef extended fill:#9a6700,color:#fff',
	'\tclassDef added fill:#cf222e,color:#fff',
	'\tclassDef untouched fill:#57606a,color:#fff',
].join('\n')

test('extractFencedMermaidBlocks finds mermaid inside wrapping example fences', () => {
	const content = [
		'Intro.',
		'',
		'````markdown',
		'```mermaid',
		'sequenceDiagram',
		'\tA->>B: hop',
		'```',
		'````',
		'',
		'~~~mermaid',
		'flowchart LR',
		'\tA --> B',
		'~~~',
	].join('\n')

	expect(extractFencedMermaidBlocks({ source: 'example.md', content })).toEqual(
		[
			{
				source: 'example.md',
				startLine: 4,
				closed: true,
				code: 'sequenceDiagram\n\tA->>B: hop',
			},
			{
				source: 'example.md',
				startLine: 10,
				closed: true,
				code: 'flowchart LR\n\tA --> B',
			},
		],
	)
})

test('parseMermaidDiagram rejects the GitHub jobs+highlight note and accepts the rephrased and visual-recap diagrams', async () => {
	const parsed = await parseMermaidDiagram(githubPlusNoteDiagram)
	expect(parsed.ok).toBe(false)
	if (parsed.ok) return
	expect(parsed.mermaidLine).toBe(8)
	expect(parsed.message).toContain("got '+'")

	const valid: Array<[string, string]> = [
		[githubPlusNoteFixed, 'sequence'],
		[visualRecapSequence, 'sequence'],
		[visualRecapFlowchart, 'flowchart-v2'],
	]
	for (const [diagram, diagramType] of valid) {
		await expect(parseMermaidDiagram(diagram)).resolves.toEqual({
			ok: true,
			diagramType,
		})
	}
})

function fenced(...diagrams: Array<string>) {
	return diagrams
		.map((diagram) => `\`\`\`mermaid\n${diagram}\n\`\`\`\n`)
		.join('\n')
}

function issue(file: string, line: number, message: unknown) {
	return expect.objectContaining({ file, line, message })
}

test('checkMermaidMarkdown reports fence-relative failures, raw stdin diagrams, and broken fences', async () => {
	const plusNoteError = expect.stringContaining("got '+'")
	const cases: Array<[string, string, Array<unknown>]> = [
		[
			'recap.md',
			[
				'<!-- system-recap:start -->',
				'',
				'### Change flow',
				'',
				fenced(githubPlusNoteDiagram),
				'<!-- system-recap:end -->',
			].join('\n'),
			[issue('recap.md', 13, plusNoteError)],
		],
		['recap.md', fenced(githubPlusNoteFixed, visualRecapFlowchart), []],
		['<stdin>', githubPlusNoteDiagram, [issue('<stdin>', 8, plusNoteError)]],
		['<stdin>', 'Just a PR description with no diagram.', []],
		[
			'docs/example.md',
			'```mermaid\nsequenceDiagram\n',
			[issue('docs/example.md', 1, 'Unclosed mermaid fence')],
		],
		[
			'docs/example.md',
			'```mermaid\n```\n',
			[issue('docs/example.md', 1, 'Empty mermaid diagram')],
		],
	]
	for (const [source, content, issues] of cases) {
		await expect(checkMermaidMarkdown({ source, content })).resolves.toEqual(
			issues,
		)
	}
})

test('parseMermaidCheckArgs rejects mixed stdin and files', () => {
	expect(parseMermaidCheckArgs(['--stdin', 'docs/a.md'])).toEqual({
		error: 'use either --stdin or file paths, not both',
	})
	expect(parseMermaidCheckArgs(['--stdin', '--label', 'recap.md'])).toEqual({
		stdin: true,
		label: 'recap.md',
		files: [],
	})
})

async function tempTree(prefix: string, files: Record<string, string>) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), prefix))
	for (const [file, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
		await writeFile(path.join(cwd, file), content)
	}
	return {
		cwd,
		[Symbol.asyncDispose]: () => rm(cwd, { recursive: true, force: true }),
	}
}

function runCli(args: Array<string>, options: { cwd: string; input?: string }) {
	return spawnSync(
		process.execPath,
		[path.join(repoRoot, 'tools/check-mermaid-syntax.ts'), ...args],
		{ encoding: 'utf8', ...options },
	)
}

test('checkMermaidSyntax scans docs and skills in a temp tree', async () => {
	await using tree = await tempTree('mermaid-check-', {
		'README.md': 'No diagram.\n',
		'AGENTS.md': 'No diagram.\n',
		'docs/contributing/ok.md': fenced(visualRecapSequence),
		'.agents/skills/visual-recap/SKILL.md': fenced(githubPlusNoteDiagram),
	})
	expect(await listMermaidSourcePaths(tree.cwd)).toEqual([
		'.agents/skills/visual-recap/SKILL.md',
		'AGENTS.md',
		'README.md',
		'docs/contributing/ok.md',
	])
	const expected = [
		expect.objectContaining({
			file: '.agents/skills/visual-recap/SKILL.md',
			message: expect.stringContaining("got '+'"),
		}),
	]
	expect(await checkMermaidSyntax(tree.cwd)).toEqual(expected)
	expect(await checkMermaidSyntax(tree.cwd, [])).toEqual(expected)
})

test('checkMermaidSyntax reads absolute paths as-is', async () => {
	await using tree = await tempTree('mermaid-abs-', {
		'inside.md': 'No diagram.\n',
	})
	const absolutePath = path.join(
		os.tmpdir(),
		`mermaid-outside-${Date.now()}.md`,
	)
	await writeFile(absolutePath, fenced(githubPlusNoteDiagram))
	try {
		const issues = await checkMermaidSyntax(tree.cwd, [absolutePath])
		expect(issues).toEqual([
			expect.objectContaining({
				file: absolutePath.replaceAll('\\', '/'),
				message: expect.stringContaining("got '+'"),
			}),
		])
	} finally {
		await rm(absolutePath, { force: true })
	}
})

test('CLI with no paths scans docs and skills', async () => {
	await using tree = await tempTree('mermaid-check-cli-', {
		'README.md': 'No diagram.\n',
		'AGENTS.md': 'No diagram.\n',
		'.agents/skills/plain/SKILL.md': 'No diagram.\n',
		'docs/broken.md': fenced(githubPlusNoteDiagram),
	})
	const result = runCli([], { cwd: tree.cwd })
	expect(result.status).toBe(1)
	expect(result.stderr).toContain('docs/broken.md:')
	expect(result.stderr).toContain("got '+'")
})

test('CLI --stdin rejects the GitHub semicolon note diagram', () => {
	const result = runCli(['--stdin', '--label', 'recap.md'], {
		cwd: repoRoot,
		input: fenced(githubPlusNoteDiagram),
	})
	expect(result.status).toBe(1)
	expect(result.stderr).toContain("got '+'")
	expect(result.stderr).toContain('recap.md:9:')
})

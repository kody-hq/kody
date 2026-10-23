import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDocsNoHostedExecute,
	findDisallowedHostedExecuteMentions,
	listHostedExecuteScanPaths,
} from './check-docs-no-hosted-execute.ts'

test('allows negations and rejects hosted execute as a fallback', () => {
	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content:
				'Do **not** use hosted MCP `execute`. Hosted MCP `execute` is banned.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: '.agents/skills/prefer-local-cli-execute/SKILL.md',
			content:
				'Prefer `@kodycodes/cli execute --local` over hosted MCP `execute`.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: '.agents/skills/ship-pr/SKILL.md',
			content: 'Run the local CLI; never hosted MCP `execute`.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/contributing/architecture/open-api.md',
			content:
				'Share-granted packages must use cloud execute instead of --local for packageStorage.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/search-and-execute.md',
			content: 'If `--local` cannot run, fall back to hosted MCP `execute`.',
		}),
	).toEqual([
		expect.objectContaining({
			file: 'docs/guides/search-and-execute.md',
			pattern: 'fall back to MCP execute',
			line: 1,
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/package-authoring.md',
			content: 'Otherwise use the MCP `execute` tool.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'otherwise use MCP execute',
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'packages/worker/src/mcp/tools/api.ts',
			content: 'Prefer hosted MCP `execute` when the CLI is missing.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'use/prefer/call/try hosted MCP execute',
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'packages/worker/src/runtime-helper.ts',
			content: 'fall back to hosted MCP `execute`',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content:
				'Do **not** fall back to hosted MCP `execute` when --local fails.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/search-and-execute.md',
			content: 'If --local is unavailable, fall back to\nhosted MCP `execute`.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'fall back to MCP execute',
			line: 1,
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: '.agents/skills/prefer-local-cli-execute/SKILL.md',
			content: 'If local execution fails, use MCP `execute`.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'if local fails, use MCP execute',
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content: 'If --local fails, try MCP `execute`.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'if local fails, use MCP execute',
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content: 'If --local fails, call the MCP `execute` tool.',
		}),
	).toEqual([
		expect.objectContaining({
			pattern: 'if local fails, use MCP execute',
		}),
	])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content: 'If --local fails, do not use MCP `execute`.',
		}),
	).toEqual([])

	expect(
		findDisallowedHostedExecuteMentions({
			relativePath: 'docs/guides/local-execute.md',
			content: 'If --local cannot run, do **not** call MCP `execute`.',
		}),
	).toEqual([])
})

test('lists scan roots and fails a planted fallback recommendation', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'docs-no-hosted-execute-'))
	try {
		await mkdir(path.join(root, 'docs/guides'), { recursive: true })
		await mkdir(path.join(root, '.agents/skills/demo'), { recursive: true })
		await writeFile(path.join(root, 'AGENTS.md'), '# agents\n', 'utf8')
		await writeFile(
			path.join(root, 'docs/guides/ok.md'),
			'Do not use hosted MCP `execute`.\n',
			'utf8',
		)
		await writeFile(
			path.join(root, 'docs/guides/bad.md'),
			'Fallback: hosted MCP `execute`.\n',
			'utf8',
		)
		await writeFile(
			path.join(root, '.agents/skills/demo/SKILL.md'),
			'# demo\n',
			'utf8',
		)

		const paths = await listHostedExecuteScanPaths(root)
		expect(paths).toEqual(
			expect.arrayContaining([
				'AGENTS.md',
				'docs/guides/bad.md',
				'docs/guides/ok.md',
				'.agents/skills/demo/SKILL.md',
			]),
		)

		const matches = await checkDocsNoHostedExecute(root)
		expect(matches).toEqual([
			expect.objectContaining({
				file: 'docs/guides/bad.md',
				pattern: 'fallback is hosted MCP execute',
				excerpt: 'Fallback: hosted MCP `execute`.',
			}),
		])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

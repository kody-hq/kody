import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { checkAgentText, findAgentTextViolations } from './check-agent-text.ts'

test('rejects em dashes in skills with a fix that names the replacement', () => {
	expect(
		findAgentTextViolations({
			relativePath: '.agents/skills/ship-pr/SKILL.md',
			content: 'Tick the PR — then merge.',
		}),
	).toEqual([
		expect.objectContaining({
			rule: 'em-dash',
			line: 1,
			column: 13,
			fix: expect.stringContaining('period, comma, colon'),
		}),
	])
})

test('rejects token values and malformed secret placeholders', () => {
	const rules = findAgentTextViolations({
		relativePath: 'AGENTS.md',
		content: [
			'Run with kody_at_abc123def456ghi.',
			'Header: {{secrets.githubToken}} or ${secret:githubToken}',
			'Good: {{secret:githubToken}} and kody_bc_… placeholders.',
		].join('\n'),
	}).map((match) => `${match.line}:${match.rule}`)
	expect(rules).toEqual([
		'1:kody-token-value',
		'2:secret-placeholder-syntax',
		'2:secret-placeholder-syntax',
	])
})

test('ignores files outside skills and AGENTS.md', () => {
	expect(
		findAgentTextViolations({
			relativePath: 'docs/guides/local-execute.md',
			content: 'A guide — with an em dash.',
		}),
	).toEqual([])
})

test('checkAgentText scans nested skill references', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'agent-text-'))
	try {
		await mkdir(path.join(cwd, '.agents/skills/demo/references'), {
			recursive: true,
		})
		await writeFile(path.join(cwd, 'AGENTS.md'), '# map\n')
		await writeFile(
			path.join(cwd, '.agents/skills/demo/references/a.md'),
			'one\ntwo — three\n',
		)
		expect(await checkAgentText(cwd)).toEqual([
			expect.objectContaining({
				file: '.agents/skills/demo/references/a.md',
				line: 2,
				rule: 'em-dash',
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})

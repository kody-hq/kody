import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-string-url-parsing'
const diagnostic = `kody-custom(${ruleName})`

async function lint(lines: Array<string>) {
	const fixturePath = path.join(
		os.tmpdir(),
		`${ruleName}-${String(process.pid)}-${String(Date.now())}.ts`,
	)
	await writeFile(fixturePath, [...lines, ''].join('\n'))
	try {
		const result = spawnSync(
			path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
			[fixturePath],
			{ cwd: repoRoot, encoding: 'utf8' },
		)
		return {
			output: `${result.stdout}\n${result.stderr}`,
			status: result.status,
		}
	} finally {
		await rm(fixturePath, { force: true })
	}
}

test('oxlint rejects string-method parsing of URL-like values', async () => {
	const result = await lint([
		'declare const url: string',
		'declare const request: { url: string }',
		'declare const item: { href: string }',
		'declare const redirectTo: string',
		'declare const origin: string',
		"export const a = url.includes('kody.codes')",
		"export const b = request.url.split('?')[0]",
		"export const c = item.href.startsWith('http')",
		"export const d = redirectTo.indexOf('#')",
		"export const e = origin.endsWith('.kody.codes')",
		"export const f = item.href.split('/')",
	])
	expect(result.output.split(diagnostic).length - 1).toBe(6)
	expect(result.output).toContain('new URL(')
	expect(result.output).toContain('URLSearchParams')
	expect(result.status).not.toBe(0)
})

test('oxlint accepts parsed URL parts and relative-link checks', async () => {
	const result = await lint([
		'declare const url: URL',
		'declare const href: string',
		'declare const apiBaseUrl: string',
		"export const a = url.pathname.startsWith('/oauth/')",
		"export const b = url.hostname.endsWith('.kody.codes')",
		"export const c = href.startsWith('/') && !href.startsWith('//')",
		"export const d = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`",
		"export const e = href.includes('\\\\')",
		'declare const urls: Array<string>',
		"export const f = urls.includes('https://kody.codes')",
	])
	expect(result.output).not.toContain(diagnostic)
})

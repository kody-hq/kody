import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const ruleName = 'no-bare-effect'
const diagnostic = `kody-custom(${ruleName})`

async function lint(lines: Array<string>) {
	const fixturePath = path.join(
		os.tmpdir(),
		`${ruleName}-${String(process.pid)}-${String(Date.now())}.tsx`,
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

test('oxlint rejects bare useEffect and useLayoutEffect', async () => {
	const bare = await lint([
		"import * as React from 'react'",
		"import { useEffect, useLayoutEffect } from 'react'",
		'export function A() {',
		'	useEffect(() => {}, [])',
		'	useLayoutEffect(() => {}, [])',
		'	React.useEffect(() => {}, [])',
		'	return null',
		'}',
	])
	expect(bare.output.split(diagnostic).length - 1).toBe(3)
	expect(bare.status).not.toBe(0)
})

test('oxlint allows the effect replacements', async () => {
	const clean = await lint([
		"import { useCallback, useSyncExternalStore } from 'react'",
		'export function A() {',
		'	const ref = useCallback((node: HTMLElement | null) => {',
		'		if (!node) return',
		'		node.focus()',
		'		return () => node.blur()',
		'	}, [])',
		'	const online = useSyncExternalStore(',
		'		() => () => {},',
		'		() => true,',
		'		() => true,',
		'	)',
		'	return online ? <div ref={ref} /> : null',
		'}',
	])
	expect(clean.output).not.toContain(diagnostic)
})

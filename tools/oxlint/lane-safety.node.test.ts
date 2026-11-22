import { spawnSync } from 'node:child_process'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const rules = [
	'require-outbound-deadline',
	'no-floating-lane-promise',
	'no-swallowed-lane-error',
] as const

async function lint(lines: Array<string>) {
	const stem = path.join(
		os.tmpdir(),
		`lane-safety-${String(process.pid)}-${String(Date.now())}`,
	)
	const fixturePath = `${stem}.ts`
	const configPath = `${stem}.json`
	await writeFile(fixturePath, [...lines, ''].join('\n'))
	await writeFile(
		configPath,
		JSON.stringify({
			jsPlugins: [path.join(repoRoot, 'tools/oxlint/local-plugin.js')],
			rules: Object.fromEntries(
				rules.map((rule) => [`kody-custom/${rule}`, 'error']),
			),
		}),
	)
	try {
		const result = spawnSync(
			path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
			['-c', configPath, fixturePath],
			{ cwd: repoRoot, encoding: 'utf8' },
		)
		const output = `${result.stdout}\n${result.stderr}`
		const count = (rule: (typeof rules)[number]) =>
			output.split(`kody-custom(${rule})`).length - 1
		return { output, status: result.status, count }
	} finally {
		await rm(fixturePath, { force: true })
		await rm(configPath, { force: true })
	}
}

test('require-outbound-deadline flags D1, KV, R2, fetch, RPC and stub calls outside withDeadline', async () => {
	const result = await lint([
		'export async function lane(env: any, stub: any) {',
		"	await env.APP_DB.prepare('SELECT 1').first()",
		"	await env.BUNDLE_ARTIFACTS_KV.delete('key')",
		"	await env.EMAIL_BLOBS.get('key')",
		"	await fetch('https://example.com')",
		'	await mailboxRpc({ env }).purge()',
		'	await stub.run()',
		'}',
	])
	expect(result.count('require-outbound-deadline')).toBe(6)
	expect(result.status).not.toBe(0)
})

test('require-outbound-deadline allows calls inside withDeadline', async () => {
	const result = await lint([
		'export async function lane(env: any) {',
		'	await withDeadline({ label: "lane.read", timeoutMs: 1 }, (signal) =>',
		"		fetch('https://example.com', { signal }),",
		'	)',
		'	await withDeadline({ label: "lane.kv", timeoutMs: 1 }, () =>',
		"		env.BUNDLE_ARTIFACTS_KV.delete('key'),",
		'	)',
		'}',
	])
	expect(result.count('require-outbound-deadline')).toBe(0)
})

test('no-floating-lane-promise flags void, bare async calls and dangling chains', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function lane() {',
		'	void audit()',
		'	audit()',
		'	audit().then(() => {})',
		'	Promise.all([audit()])',
		'}',
	])
	expect(result.count('no-floating-lane-promise')).toBe(4)
})

test('no-floating-lane-promise allows awaited, returned and waitUntil promises', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function lane(ctx: { waitUntil: (p: Promise<unknown>) => void }) {',
		'	await audit()',
		'	ctx.waitUntil(audit())',
		'	return audit()',
		'}',
	])
	expect(result.count('no-floating-lane-promise')).toBe(0)
})

test('no-swallowed-lane-error flags catch blocks and .catch handlers that drop the error', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function lane() {',
		'	try {',
		'		await audit()',
		'	} catch {}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		"		console.warn('lane-failed', error)",
		'	}',
		'	await audit().catch(() => {})',
		'}',
	])
	expect(result.count('no-swallowed-lane-error')).toBe(3)
})

test('no-swallowed-lane-error allows rethrow, typed failures, mappers, collectors and reportLaneError', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function lane(warnings: Array<string>) {',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		'		throw error',
		'	}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		"		return { kind: 'audit_failed' as const, error }",
		'	}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		"		mapLaneFailure({ kind: 'audit_failed', error })",
		'	}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		'		warnings.push(String(error))',
		'	}',
		"	await audit().catch((error) => reportLaneError('warn', 'audit', error))",
		'}',
	])
	expect(result.count('no-swallowed-lane-error')).toBe(0)
})

test('the lane rules are errors for every file in the lane path list, and every listed file exists', async () => {
	const config = JSON.parse(
		await readFile(
			path.join(repoRoot, 'tools/oxlint/oxlint-rules.json'),
			'utf8',
		),
	) as {
		overrides: Array<{ files: Array<string>; rules: Record<string, string> }>
	}
	const laneOverride = config.overrides.find(
		(override) => 'kody-custom/require-outbound-deadline' in override.rules,
	)
	expect(laneOverride?.files).toContain(
		'**/packages/worker/src/scheduled/scheduled-lanes.ts',
	)
	for (const rule of rules) {
		expect(laneOverride?.rules[`kody-custom/${rule}`]).toBe('error')
	}
	for (const file of laneOverride?.files ?? []) {
		await access(path.join(repoRoot, file.replace(/^\*\*\//, '')))
	}
})

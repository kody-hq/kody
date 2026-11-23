import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const rules = [
	'require-outbound-deadline',
	'no-floating-promise',
	'no-swallowed-error',
] as const

async function lint(
	lines: Array<string>,
	siblings: Record<string, string> = {},
) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'request-path-safety-'))
	const fixturePath = path.join(dir, 'fixture.ts')
	const configPath = path.join(dir, 'oxlint.json')
	await writeFile(fixturePath, [...lines, ''].join('\n'))
	for (const [name, text] of Object.entries(siblings)) {
		await writeFile(path.join(dir, name), text)
	}
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
		await rm(dir, { recursive: true, force: true })
	}
}

test('require-outbound-deadline flags D1, KV, R2, fetch, RPC, stub and artifacts repo calls outside withDeadline', async () => {
	const result = await lint([
		'export async function step(env: any, stub: any, repo: any, bucket: any) {',
		"	await env.APP_DB.prepare('SELECT 1').first()",
		"	await env.BUNDLE_ARTIFACTS_KV.delete('key')",
		"	await bucket.head('key')",
		"	await fetch('https://example.com')",
		'	await repoSessionRpc({ env }).persist()',
		'	await stub.run()',
		'	await repo.info()',
		'}',
	])
	expect(result.count('require-outbound-deadline')).toBe(7)
	expect(result.status).not.toBe(0)
})

test('require-outbound-deadline treats imported boundary helpers as outbound calls', async () => {
	const result = await lint([
		"import { routeExecute } from '#worker/execution-contexts/routing.ts'",
		"import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'",
		'export async function step(input: any) {',
		'	await routeExecute(input)',
		'	await resolveArtifactSourceHead(input)',
		'}',
	])
	expect(result.count('require-outbound-deadline')).toBe(2)
})

test('require-outbound-deadline allows calls inside withDeadline', async () => {
	const result = await lint([
		"import { routeExecute } from '#worker/execution-contexts/routing.ts'",
		'export async function step(env: any, input: any) {',
		'	await withDeadline({ label: "step.fetch", timeoutMs: 1 }, (signal) =>',
		"		fetch('https://example.com', { signal }),",
		'	)',
		'	await withDeadline({ label: "step.kv", timeoutMs: 1 }, () =>',
		"		env.BUNDLE_ARTIFACTS_KV.delete('key'),",
		'	)',
		'	await withDeadline({ label: "step.route", timeoutMs: 1 }, (signal) =>',
		'		routeExecute({ ...input, signal }),',
		'	)',
		'}',
	])
	expect(result.count('require-outbound-deadline')).toBe(0)
})

test('no-floating-promise flags void, bare async calls, dangling chains and Promise statics', async () => {
	const result = await lint([
		'async function audit() {}',
		'const auditArrow = async () => {}',
		'export async function step() {',
		'	void audit()',
		'	audit()',
		'	auditArrow()',
		'	audit().then(() => {})',
		'	Promise.all([audit()])',
		'}',
	])
	expect(result.count('no-floating-promise')).toBe(5)
})

test('no-floating-promise flags calls to imported async functions', async () => {
	const result = await lint(
		[
			"import { purge, purgeArrow, syncHelper } from './helpers.ts'",
			'export async function step() {',
			'	purge()',
			'	void purgeArrow()',
			'	syncHelper()',
			'}',
		],
		{
			'helpers.ts': [
				'export async function purge() {}',
				'export const purgeArrow = async () => {}',
				'export function syncHelper() {}',
				'',
			].join('\n'),
		},
	)
	expect(result.count('no-floating-promise')).toBe(2)
})

test('no-floating-promise allows awaited, returned and waitUntil promises', async () => {
	const result = await lint(
		[
			"import { purge } from './helpers.ts'",
			'async function audit() {}',
			'export async function step(ctx: { waitUntil: (p: Promise<unknown>) => void }) {',
			'	await audit()',
			'	await purge()',
			'	ctx.waitUntil(audit())',
			'	ctx.waitUntil(purge())',
			'	return audit()',
			'}',
		],
		{ 'helpers.ts': 'export async function purge() {}\n' },
	)
	expect(result.count('no-floating-promise')).toBe(0)
})

test('no-swallowed-error flags catch blocks and .catch handlers that drop the error', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function step() {',
		'	try {',
		'		await audit()',
		'	} catch {}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		"		console.warn('step-failed', error)",
		'	}',
		'	try {',
		'		await audit()',
		'	} catch {',
		'		return null',
		'	}',
		'	await audit().catch(() => {})',
		'	await audit().then(undefined, () => false)',
		'}',
	])
	expect(result.count('no-swallowed-error')).toBe(5)
})

test('no-swallowed-error allows rethrow, typed failures, failure builders, edge error responses, collectors and reportHandledError', async () => {
	const result = await lint([
		'async function audit() {}',
		'export async function step(warnings: Array<string>) {',
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
		'		return deadlineFailure(error)',
		'	}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		'		warnings.push(String(error))',
		'	}',
		'	try {',
		'		await audit()',
		'	} catch (error) {',
		'		return apiErrorResponse(error)',
		'	}',
		"	await audit().catch((error) => reportHandledError('step.audit', error))",
		'}',
	])
	expect(result.count('no-swallowed-error')).toBe(0)
})

const requestPathDirectories = [
	'**/packages/worker/src/open-api/**',
	'**/packages/worker/src/publish-offload/**',
]

test('the request-path rules are errors for the request-path directories and every listed file exists', async () => {
	const config = JSON.parse(
		await readFile(
			path.join(repoRoot, 'tools/oxlint/oxlint-rules.json'),
			'utf8',
		),
	) as {
		overrides: Array<{ files: Array<string>; rules: Record<string, string> }>
	}
	const pathOverride = config.overrides.find(
		(override) =>
			override.rules['kody-custom/require-outbound-deadline'] === 'error',
	)
	for (const directory of requestPathDirectories) {
		expect(pathOverride?.files).toContain(directory)
	}
	for (const rule of rules) {
		expect(pathOverride?.rules[`kody-custom/${rule}`]).toBe('error')
	}
	for (const file of pathOverride?.files ?? []) {
		if (file.endsWith('/**')) continue
		await access(path.join(repoRoot, file.replace(/^\*\*\//, '')))
	}
})

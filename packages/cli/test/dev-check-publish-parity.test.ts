import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import {
	parsePackageCheckResult,
	runDevCheck,
	type PackageCheckResult,
} from '../src/dev-command.js'

const stampGateMessage =
	'Credential stamp publish gate (issue #3836 phase 1):\nsrc/index.ts uses a computed |scope= placeholder.'

/**
 * The reported case: a stamped package (kody.credentials) whose fetch uses a
 * `{{secret:TOKEN|scope=package}}` placeholder. Every local check passes;
 * publish refuses it at the credential stamp gate.
 */
async function writeStampedScopePackage(root: string) {
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({
			name: '@local/poll',
			type: 'module',
			exports: { './poll': './src/index.ts' },
			kody: {
				id: 'poll',
				credentials: { TOKEN: { kind: 'secret', description: 'API token' } },
			},
		}),
	)
	await writeFile(join(root, 'README.md'), '# poll\n')
	await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
	await mkdir(join(root, 'src'), { recursive: true })
	await writeFile(
		join(root, 'src/index.ts'),
		`export default async function poll() {
	const response = await fetch('https://api.example.com/poll', {
		headers: { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' },
	})
	return response.status
}
`,
	)
	await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
	await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'export {}\n')
}

async function withPackage(fn: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-parity-'))
	try {
		await writeStampedScopePackage(root)
		await fn(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

function capture() {
	let stdout = ''
	return {
		io: {
			stdout: (text: string) => {
				stdout += text
			},
			stderr: () => {},
		},
		get stdout() {
			return stdout
		},
	}
}

const refusesLikePublish = async (): Promise<PackageCheckResult> => ({
	ok: false,
	checks: [
		{ kind: 'manifest', ok: true, message: 'Validated package.json.' },
		{ kind: 'credentials', ok: false, message: stampGateMessage },
	],
})

test('kody dev check fails the stamped |scope=package case that publish refuses', async () => {
	await withPackage(async (root) => {
		let sent: Record<string, string> = {}
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			io: out.io,
			runPublishChecks: async (files) => {
				sent = files
				return refusesLikePublish()
			},
		})
		assert.equal(code, 1)
		assert.match(out.stdout, /^FAIL\s+publish:credentials/m)
		assert.match(out.stdout, /Credential stamp publish gate/)
		assert.doesNotMatch(out.stdout, /kody dev check passed/)
		// The server sees the package tree, not dependencies.
		assert.match(sent['src/index.ts'] ?? '', /\|scope=package/)
		assert.ok(sent['package.json'])
		assert.ok(
			!Object.keys(sent).some((path) => path.startsWith('node_modules/')),
		)
	})
})

test('kody dev check --json reports publish check results', async () => {
	await withPackage(async (root) => {
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			json: true,
			io: out.io,
			runPublishChecks: refusesLikePublish,
		})
		assert.equal(code, 1)
		const parsed = JSON.parse(out.stdout) as {
			ok: boolean
			publishChecks: { ran: boolean; ok: boolean | null }
			checks: Array<{ name: string; ok: boolean }>
		}
		assert.equal(parsed.ok, false)
		assert.deepEqual(parsed.publishChecks, { ran: true, ok: false })
		assert.ok(
			parsed.checks.some(
				(check) => check.name === 'publish:credentials' && !check.ok,
			),
		)
	})
})

test('kody dev check fails closed when publish checks cannot run', async () => {
	await withPackage(async (root) => {
		const unreachable = capture()
		assert.equal(
			await runDevCheck({
				target: 'mock',
				cwd: root,
				io: unreachable.io,
				runPublishChecks: async () => {
					throw new Error('Not signed in.')
				},
			}),
			1,
		)
		assert.match(unreachable.stdout, /^FAIL\s+publish checks/m)
		assert.match(unreachable.stdout, /could not run: Not signed in\./)
		assert.match(unreachable.stdout, /--offline/)

		const noRunner = capture()
		assert.equal(
			await runDevCheck({ target: 'mock', cwd: root, io: noRunner.io }),
			1,
		)
		assert.match(noRunner.stdout, /^FAIL\s+publish checks/m)
	})
})

test('kody dev check --offline runs local checks only and says publish can still refuse', async () => {
	await withPackage(async (root) => {
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			offline: true,
			io: out.io,
			runPublishChecks: async () => {
				throw new Error('must not be called offline')
			},
		})
		assert.equal(code, 0)
		assert.match(out.stdout, /^WARN\s+publish checks/m)
		assert.match(out.stdout, /can still refuse this package/)
	})
})

test('--offline is only accepted by kody dev check', async () => {
	let stderr = ''
	const code = await runCli(['search', 'x', '--offline'], {
		stdout: () => {},
		stderr: (text) => {
			stderr += text
		},
	})
	assert.notEqual(code, 0)
	assert.match(stderr, /--offline/)
})

test('parsePackageCheckResult validates the packageCheck response', () => {
	assert.deepEqual(
		parsePackageCheckResult({
			ok: false,
			package_name: '@local/poll',
			checks: [{ kind: 'credentials', ok: false, message: 'no' }],
		}),
		{ ok: false, checks: [{ kind: 'credentials', ok: false, message: 'no' }] },
	)
	assert.throws(() => parsePackageCheckResult({ ok: true }), /unexpected/)
})

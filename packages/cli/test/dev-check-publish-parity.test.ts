import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import {
	parsePackageCheckResult,
	PublishChecksAuthError,
	runDevCheck,
	type PackageCheckResult,
} from '../src/dev-command.js'
import { OpenApiError } from '../src/open-api-client.js'

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

test('kody dev check passes a data-only app package with no exports field', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-check-no-exports-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/board',
				type: 'module',
				kody: {
					id: 'board',
					description: 'Data-only package with an app.',
					app: { entry: './src/app.ts' },
				},
			}),
		)
		await writeFile(join(root, 'README.md'), '# board\n')
		await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(
			join(root, 'src/app.ts'),
			'export default { async fetch() { return new Response("ok") } }\n',
		)
		let sentManifest: Record<string, unknown> = {}
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			io: out.io,
			runPublishChecks: async (files) => {
				sentManifest = JSON.parse(files['package.json'] ?? '{}')
				return {
					ok: true,
					checks: [
						{ kind: 'manifest', ok: true, message: 'Validated package.json.' },
					],
				}
			},
		})
		assert.equal(code, 0, out.stdout)
		assert.equal('exports' in sentManifest, false)
		assert.match(out.stdout, /^ok\s+app\.entry bundle/m)
		assert.match(out.stdout, /^ok\s+publish:manifest/m)
		assert.doesNotMatch(out.stdout, /export:/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('kody dev check sends binary files by path and size so binary-only app assets count', async () => {
	await withPackage(async (root) => {
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
		])
		await mkdir(join(root, 'icons'), { recursive: true })
		await writeFile(join(root, 'icons/icon-192.png'), png)
		await writeFile(join(root, 'icons/icon-512.png'), Buffer.concat([png, png]))
		let sentFiles: Record<string, string> = {}
		let sentBinary: Record<string, number> = {}
		const out = capture()
		const code = await runDevCheck({
			target: 'mock',
			cwd: root,
			io: out.io,
			runPublishChecks: async (files, binaryFiles) => {
				sentFiles = files
				sentBinary = binaryFiles
				return { ok: true, checks: [{ kind: 'bundle', ok: true, message: '' }] }
			},
		})
		assert.equal(code, 0, out.stdout)
		assert.deepEqual(sentBinary, {
			'icons/icon-192.png': png.byteLength,
			'icons/icon-512.png': png.byteLength * 2,
		})
		assert.ok(!Object.keys(sentFiles).some((path) => path.startsWith('icons/')))
		assert.match(out.stdout, /sent 2 binary file\(s\) by path and size only/)
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

test('kody dev check shows the login hint only for auth failures', async () => {
	await withPackage(async (root) => {
		const serverDown = capture()
		assert.equal(
			await runDevCheck({
				target: 'mock',
				cwd: root,
				json: true,
				io: serverDown.io,
				runPublishChecks: async () => {
					throw new OpenApiError(
						'The Kody API ran out of server memory or CPU time before it answered this request (request id ray-1).',
						{
							status: 503,
							code: 'internal_error',
							reason: 'origin_resource_limit',
							requestId: 'ray-1',
						},
					)
				},
			}),
			1,
		)
		const parsed = JSON.parse(serverDown.stdout) as {
			checks: Array<{ name: string; ok: boolean; detail?: string }>
			publishChecks: Record<string, unknown>
		}
		const failure = parsed.checks.find(
			(check) => check.name === 'publish checks',
		)
		assert.ok(failure && !failure.ok)
		assert.doesNotMatch(failure.detail ?? '', /kody login/)
		assert.match(
			failure.detail ?? '',
			/\(HTTP 503, code internal_error, reason origin_resource_limit\)/,
		)
		assert.match(failure.detail ?? '', /request id ray-1/)
		assert.deepEqual(parsed.publishChecks, {
			ran: false,
			ok: null,
			error: {
				message:
					'The Kody API ran out of server memory or CPU time before it answered this request (request id ray-1).',
				status: 503,
				code: 'internal_error',
				reason: 'origin_resource_limit',
				requestId: 'ray-1',
			},
		})

		for (const authError of [
			new PublishChecksAuthError('Not signed in.'),
			new OpenApiError('Kody rejected the API token.', {
				status: 401,
				code: 'unauthorized',
			}),
		]) {
			const out = capture()
			await runDevCheck({
				target: 'mock',
				cwd: root,
				io: out.io,
				runPublishChecks: async () => {
					throw authError
				},
			})
			assert.match(out.stdout, /Sign in with `kody login`/)
		}
	})
})

test('--debug is only accepted by kody dev check', async () => {
	let stderr = ''
	const code = await runCli(['search', 'x', '--debug'], {
		stdout: () => {},
		stderr: (text) => {
			stderr += text
		},
	})
	assert.notEqual(code, 0)
	assert.match(stderr, /--debug/)
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

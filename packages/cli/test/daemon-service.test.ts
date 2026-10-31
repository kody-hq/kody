import assert from 'node:assert/strict'
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { mock, test } from 'node:test'

const configHome = mkdtempSync(join(tmpdir(), 'kody-daemon-service-'))
// macOS ignores XDG_CONFIG_HOME, and Windows uses APPDATA. Keep daemon
// runtime state inside this test's directory on every native build runner.
mock.method(os, 'homedir', () => configHome)
syncBuiltinESMExports()
process.env.XDG_CONFIG_HOME = configHome
process.env.APPDATA = configHome
delete process.env.KODY_CONTEXT_KEY_PASSPHRASE

const { generateContextKey, importContextKey } =
	await import('../src/execution-context/client.js')
const { runDaemon } = await import('../src/execution-context/daemon.js')
const keystore = await import('../src/execution-context/keystore.js')
const service = await import('../src/execution-context/service.js')
const serviceCommands =
	await import('../src/execution-context/service-commands.js')

const apiUrl = 'https://api.kody.test'
const entry = join(configHome, 'cli', 'dist', 'bin.js')
writeFileSync(join(configHome, 'placeholder'), '')
await import('node:fs').then(({ mkdirSync }) =>
	mkdirSync(join(configHome, 'cli', 'dist'), { recursive: true }),
)
writeFileSync(entry, '')
const program = { node: process.execPath, entry, version: '1.2.3' }

function unitInput(manager: 'systemd' | 'launchd', ecid = 'ec_unit') {
	return {
		ecid,
		contextName: 'Build box',
		apiUrl,
		program,
		paths: service.servicePaths({ apiUrl, ecid, manager }),
		maxConcurrent: 3,
		platform: manager === 'systemd' ? 'linux' : 'darwin',
		env: {
			KODY_API_TOKEN: 'kody_at_secret',
			KODY_CONTEXT_KEY_PASSPHRASE: 'hunter2',
		},
	} as const
}

function assertNoSecrets(text: string) {
	assert.doesNotMatch(text, /kody_at_secret|hunter2|TOKEN|PASSPHRASE/)
}

test('the systemd unit restarts on crashes, not on a revoke, and holds no secrets', () => {
	const unit = service.systemdUnit(unitInput('systemd'))
	for (const line of [
		'Restart=always',
		'RestartSec=10',
		'StartLimitIntervalSec=300',
		'StartLimitBurst=5',
		`RestartPreventExitStatus=${service.stayStoppedExitCode}`,
		'WantedBy=default.target',
	]) {
		assert.ok(unit.includes(`\n${line}\n`), line)
	}
	assert.match(unit, /^Environment="PATH=[^"]*\/usr\/bin[^"]*"$/m)
	assert.match(unit, /^Environment="KODY_DAEMON_SERVICE=systemd"$/m)
	assert.match(
		unit,
		new RegExp(
			`^WorkingDirectory=/.*${'/kody/contexts/ec_unit'.replace(/\//g, '\\/')}$`,
			'm',
		),
	)
	assert.match(unit, /StandardOutput=append:.*\/contexts\/ec_unit\/daemon\.log/)
	assert.match(
		unit,
		/ExecStart=".*node" ".*bin\.js" "daemon" "--context" "ec_unit" "--api-url" "https:\/\/api\.kody\.test" "--max-concurrent" "3"/,
	)
	assertNoSecrets(unit)
	assert.deepEqual(service.programInUnit(unit, 'systemd'), {
		node: process.execPath,
		entry,
	})
})

test('the LaunchAgent runs at load, keeps only failed exits alive, and holds no secrets', () => {
	const plist = service.launchdPlist({
		...unitInput('launchd'),
		contextName: 'a <b> & "c"',
	})
	assert.match(
		plist,
		/<key>Label<\/key>\s*<string>codes\.kody\.daemon\.ec_unit<\/string>/,
	)
	assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
	assert.match(
		plist,
		/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
	)
	assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
	assert.match(
		plist,
		/<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin[^<]*<\/string>/,
	)
	assert.match(
		plist,
		/<key>WorkingDirectory<\/key>\s*<string>[^<]*\/contexts\/ec_unit<\/string>/,
	)
	assert.match(
		plist,
		/<key>StandardOutPath<\/key>\s*<string>[^<]*daemon\.log<\/string>/,
	)
	assertNoSecrets(plist)
	assert.deepEqual(service.programInUnit(plist, 'launchd'), {
		node: process.execPath,
		entry,
	})
	assert.ok(
		service
			.servicePaths({
				apiUrl,
				ecid: 'ec_unit',
				manager: 'launchd',
				home: '/Users/k',
			})
			.unitPath.endsWith(
				'/Users/k/Library/LaunchAgents/codes.kody.daemon.ec_unit.plist',
			),
	)
})

test('install refuses an npx, pnpm dlx, or bunx copy of the CLI and says how to fix it', async () => {
	for (const [path, how] of [
		['/home/u/.npm/_npx/9f2/node_modules/@kodycodes/cli/dist/bin.js', 'npx'],
		[
			'/home/u/.cache/pnpm/dlx/abc/node_modules/@kodycodes/cli/dist/bin.js',
			'pnpm dlx',
		],
		[
			'/tmp/bunx-1000-@kodycodes/cli/node_modules/@kodycodes/cli/dist/bin.js',
			'bunx',
		],
	] as const) {
		assert.equal(service.ephemeralRuntimeReason(path, null), how)
	}
	assert.equal(
		service.ephemeralRuntimeReason(
			'/usr/local/lib/node_modules/@kodycodes/cli/dist/bin.js',
			'/tmp',
		),
		null,
	)
	await assert.rejects(
		serviceCommands.installDaemonService(
			{
				apiUrl,
				clientVersion: '1.2.3',
				write: () => {},
				platform: 'linux',
				isRoot: false,
				entryPath:
					'/home/u/.npm/_npx/9f2/node_modules/@kodycodes/cli/dist/bin.js',
				run: () => assert.fail('must not touch systemctl'),
			},
			{ ecid: 'ec_unit' },
		),
		/running from npx[\s\S]*npm install -g @kodycodes\/cli[\s\S]*kody daemon install/,
	)
})

test('install refuses root and Windows with a clear message', async () => {
	const env = {
		apiUrl,
		clientVersion: '1.2.3',
		write: () => {},
		entryPath: entry,
		run: () => assert.fail('must not run'),
	}
	await assert.rejects(
		serviceCommands.installDaemonService(
			{ ...env, platform: 'linux', isRoot: true },
			{ ecid: 'ec_unit' },
		),
		/Refusing to install the kody daemon service as root/,
	)
	await assert.rejects(
		serviceCommands.installDaemonService(
			{ ...env, platform: 'win32', isRoot: false },
			{ ecid: 'ec_unit' },
		),
		/Windows is not supported yet/,
	)
})

type Call = Array<string>
function fakeSystemd(state: {
	active: boolean
	enabled: boolean
	linger: 'yes' | 'no'
	pid?: number
}) {
	const calls: Array<Call> = []
	const run: import('../src/execution-context/service.js').CommandRunner = (
		command,
		args,
	) => {
		calls.push([command, ...args])
		if (command === 'loginctl')
			return { ok: true, stdout: `${state.linger}\n`, stderr: '' }
		if (args[1] === 'show') {
			return {
				ok: true,
				stdout: `ActiveState=${state.active ? 'active' : 'inactive'}\nUnitFileState=${state.enabled ? 'enabled' : 'disabled'}\nMainPID=${state.active ? (state.pid ?? 4242) : 0}\n`,
				stderr: '',
			}
		}
		if (args[1] === 'is-active')
			return {
				ok: state.active,
				stdout: state.active ? 'active\n' : 'inactive\n',
				stderr: '',
			}
		if (args[1] === 'start' || args[1] === 'restart') state.active = true
		if (args[1] === 'enable') state.enabled = true
		return { ok: true, stdout: '', stderr: '' }
	}
	return { calls, run }
}

async function storeContext(
	ecid: string,
	wrapping: import('../src/execution-context/keystore.js').WrappingKeySource,
) {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	keystore.saveContext({
		context: {
			version: 1,
			ecid,
			name: 'Build box',
			apiUrl,
			orgSlug: null,
			publicKeyJwk,
		},
		privateJwk: privateKeyJwk,
		wrapping,
	})
	return privateKeyJwk
}

test('status names each problem with the command that fixes it', () => {
	const notInstalled = service.serviceStatus({
		apiUrl,
		ecid: 'ec_status',
		cliVersion: '1.2.3',
		platform: 'linux',
		isRoot: false,
		run: fakeSystemd({ active: false, enabled: false, linger: 'no' }).run,
	})
	assert.deepEqual(
		notInstalled.problems.map((p) => [p.code, p.fix]),
		[['not-installed', 'kody daemon install']],
	)
	const unitPath = service.servicePaths({
		apiUrl,
		ecid: 'ec_status',
		manager: 'systemd',
	}).unitPath
	const unit = service.systemdUnit({
		...unitInput('systemd', 'ec_status'),
		program: { ...program, node: '/gone/node' },
	})
	const broken = service.serviceStatus({
		apiUrl,
		ecid: 'ec_status',
		cliVersion: '1.2.3',
		tmpDir: null,
		expectedUnit: 'something else',
		keyWrap: 'passphrase',
		platform: 'linux',
		isRoot: false,
		readText: (path) => (path === unitPath ? unit : null),
		run: fakeSystemd({ active: false, enabled: false, linger: 'no' }).run,
	})
	const fixes = Object.fromEntries(broken.problems.map((p) => [p.code, p.fix]))
	assert.deepEqual(Object.keys(fixes).sort(), [
		'key-needs-passphrase',
		'linger-disabled',
		'not-enabled',
		'not-running',
		'program-missing',
		'unit-outdated',
	])
	assert.match(fixes['linger-disabled']!, /^sudo loginctl enable-linger \S+$/)
	assert.equal(fixes['program-missing'], 'kody daemon install')
	assert.equal(
		fixes['key-needs-passphrase'],
		'kody daemon install --key-storage file',
	)
	const text = service.formatServiceStatus(broken, 'Build box')
	assert.match(
		text,
		/\[linger-disabled\][^\n]*\n\s+Fix: sudo loginctl enable-linger/,
	)
	const windows = service.serviceStatus({
		apiUrl,
		ecid: null,
		cliVersion: '1.2.3',
		platform: 'win32',
	})
	assert.equal(windows.supported, false)
	assert.match(windows.problems[0]!.message, /Windows is not supported yet/)
})

test('install writes the unit, starts it, repairs on re-run, and restarts onto a new version', async () => {
	const ecid = 'ec_install'
	await storeContext(
		ecid,
		keystore.fileWrappingKey({ apiUrl, ecid, create: true }),
	)
	const systemd = fakeSystemd({ active: false, enabled: false, linger: 'yes' })
	const lines: Array<string> = []
	const env = {
		apiUrl,
		clientVersion: '1.2.3',
		write: (text: string) => lines.push(text),
		platform: 'linux' as const,
		isRoot: false,
		entryPath: entry,
		tmpDir: null,
		run: systemd.run,
		startupWaitMs: 0,
	}
	const status = await serviceCommands.installDaemonService(env, { ecid })
	const paths = service.servicePaths({ apiUrl, ecid, manager: 'systemd' })
	assert.ok(existsSync(paths.unitPath))
	assert.doesNotMatch(
		readFileSync(paths.unitPath, 'utf8'),
		/secret|TOKEN|PASSPHRASE/,
	)
	const verbs = () =>
		systemd.calls.filter((c) => c[0] === 'systemctl').map((c) => c[2])
	assert.deepEqual(verbs().slice(0, 5), [
		'daemon-reload',
		'enable',
		'reset-failed',
		'is-active',
		'start',
	])
	assert.equal(status.running, true)
	assert.deepEqual(status.problems, [])

	systemd.calls.length = 0
	await serviceCommands.installDaemonService(env, { ecid })
	assert.ok(
		!verbs().includes('restart'),
		'an unchanged, current service is left running',
	)

	writeFileSync(paths.unitPath, '[Service]\nExecStart=/old\n')
	service.writeJson(paths.statePath, {
		pid: 4242,
		version: '1.2.3',
		service: 'systemd',
		startedAt: 'x',
	})
	systemd.calls.length = 0
	await serviceCommands.installDaemonService(env, { ecid })
	assert.ok(
		verbs().includes('restart'),
		'a damaged unit is rewritten and restarted',
	)

	service.writeJson(paths.statePath, {
		pid: 4242,
		version: '1.0.0',
		service: 'systemd',
		startedAt: 'x',
	})
	systemd.calls.length = 0
	await serviceCommands.installDaemonService(env, { ecid })
	assert.ok(
		verbs().includes('restart'),
		'a daemon on an older version is restarted onto this one',
	)
})

test('uninstall removes the service and offers to revoke; revoking offers to uninstall', async () => {
	const ecid = 'ec_uninstall'
	await storeContext(
		ecid,
		keystore.fileWrappingKey({ apiUrl, ecid, create: true }),
	)
	const systemd = fakeSystemd({ active: false, enabled: false, linger: 'yes' })
	const questions: Array<string> = []
	const env = {
		apiUrl,
		clientVersion: '1.2.3',
		write: () => {},
		platform: 'linux' as const,
		isRoot: false,
		entryPath: entry,
		tmpDir: null,
		run: systemd.run,
		startupWaitMs: 0,
		confirm: async (question: string) => {
			questions.push(question)
			return true
		},
	}
	await serviceCommands.installDaemonService(env, { ecid })
	const unitPath = service.servicePaths({
		apiUrl,
		ecid,
		manager: 'systemd',
	}).unitPath
	const revoked: Array<string> = []
	await serviceCommands.runDaemonServiceCommand(env, {
		sub: 'uninstall',
		context: ecid,
		revoke: async (id) => {
			revoked.push(id)
		},
	})
	assert.ok(!existsSync(unitPath))
	assert.deepEqual(revoked, [ecid])
	assert.match(questions.at(-1)!, /Also revoke/)
	assert.ok(
		systemd.calls.some(
			(c) =>
				c.join(' ') ===
				`systemctl --user disable --now kody-daemon-${ecid}.service`,
		),
	)

	await serviceCommands.installDaemonService(env, { ecid })
	await serviceCommands.offerUninstallAfterRevoke(env, {
		ref: 'Build box',
		ecid,
	})
	assert.ok(!existsSync(unitPath))
	assert.match(questions.at(-1)!, /Remove the service/)
})

test('the file wrapping key is 600 and replaces a passphrase without a passphrase in the service', async () => {
	const ecid = 'ec_filekey'
	const passphrase = keystore.resolveWrappingKey({
		ecid,
		create: true,
		env: { KODY_CONTEXT_KEY_PASSPHRASE: 'correct horse battery staple' },
	})
	const privateJwk = await storeContext(ecid, passphrase)
	keystore.rewrapContextKey({
		apiUrl,
		ecid,
		from: passphrase,
		to: keystore.fileWrappingKey({ apiUrl, ecid, create: true }),
	})
	const keyPath = keystore.fileWrappingKeyPath(apiUrl, ecid)
	assert.equal(statSync(keyPath).mode & 0o777, 0o600)
	assert.equal(keystore.storedKeyWrap(apiUrl, ecid), 'file')
	const loaded = keystore.loadContext({
		apiUrl,
		ecid,
		wrapping: keystore.wrappingKeyForStoredContext({ apiUrl, ecid, env: {} }),
	})
	assert.deepEqual(loaded.privateJwk, privateJwk)
	assert.throws(
		() =>
			keystore
				.fileWrappingKey({ apiUrl, ecid: 'ec_nofile', create: false })
				.key(Buffer.alloc(16)),
		/file key for this execution context is missing/,
	)
})

async function daemonInput(fetchFn: typeof fetch) {
	const { privateKeyJwk } = await generateContextKey()
	const lines: Array<string> = []
	return {
		lines,
		input: {
			apiUrl,
			ecid: 'ec_test',
			privateKey: await importContextKey(privateKeyJwk),
			serverKeys: [],
			maxConcurrent: 1,
			client: { name: 'kody-cli', version: '0.0.0' },
			capabilities: {},
			execute: async () => ({ isError: false }),
			log: (line: string) => lines.push(line),
			fetchFn,
		},
	}
}

test('a revoked or deleted context stops for good instead of reconnecting forever', async () => {
	for (const [status, reason] of [
		[403, 'revoked'],
		[401, 'unknown_context'],
	] as const) {
		let calls = 0
		const { input, lines } = await daemonInput((async () => {
			calls += 1
			return Response.json(
				{
					error: {
						code: 'unauthorized',
						message: `Refused (${reason}).`,
						details: { reason },
					},
				},
				{ status },
			)
		}) as typeof fetch)
		const started = Date.now()
		assert.equal(await runDaemon(input), reason)
		assert.equal(calls, 1, 'no retry after a permanent refusal')
		assert.ok(Date.now() - started < 1000)
		assert.match(lines.join('\n'), /Stopping for good/)
	}
	let calls = 0
	const abort = new AbortController()
	const { input } = await daemonInput((async () => {
		calls += 1
		if (calls === 2) abort.abort()
		return Response.json(
			{ error: { code: 'unavailable', message: 'down' } },
			{ status: 503 },
		)
	}) as typeof fetch)
	setTimeout(() => abort.abort(), 4000)
	assert.equal(await runDaemon({ ...input, signal: abort.signal }), 'shutdown')
	assert.ok(calls >= 1, 'a transient failure is retried until stopped')
})

test('a drained daemon does not connect again', async () => {
	const drain = new AbortController()
	drain.abort()
	let calls = 0
	const { input } = await daemonInput((async () => {
		calls += 1
		return Response.json({})
	}) as typeof fetch)
	assert.equal(
		await runDaemon({ ...input, drainSignal: drain.signal }),
		'shutdown',
	)
	assert.equal(calls, 0)
})

test('repair keeps --max-concurrent from both a systemd unit and a LaunchAgent plist', () => {
	for (const manager of ['systemd', 'launchd'] as const) {
		const text =
			manager === 'systemd'
				? service.systemdUnit(unitInput(manager))
				: service.launchdPlist(unitInput(manager))
		assert.equal(serviceCommands.maxConcurrentInUnit(text), 3, manager)
	}
	assert.equal(serviceCommands.maxConcurrentInUnit(null), undefined)
})

test('a passphrase context refuses --key-storage keyring for a service', async () => {
	const ecid = 'ec_passkeyring'
	await storeContext(
		ecid,
		keystore.resolveWrappingKey({
			ecid,
			create: true,
			env: { KODY_CONTEXT_KEY_PASSPHRASE: 'correct horse battery staple' },
		}),
	)
	await assert.rejects(
		serviceCommands.installDaemonService(
			{
				apiUrl,
				clientVersion: '1.2.3',
				write: () => {},
				platform: 'linux',
				isRoot: false,
				entryPath: entry,
				tmpDir: null,
				run: () => assert.fail('must not touch systemctl'),
			},
			{ ecid, keyStorage: 'keyring' },
		),
		/passphrase-protected context[\s\S]*--key-storage file/,
	)
})

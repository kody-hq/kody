import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
	chmodSync,
	utimesSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'

const configHome = mkdtempSync(join(tmpdir(), 'kody-auto-update-'))
process.env.XDG_CONFIG_HOME = configHome
delete process.env.KODY_DAEMON_AUTO_UPDATE

const update = await import('../src/execution-context/auto-update.js')
const fsAccess = await import('../src/execution-context/fs-access.js')
const lock = await import('../src/execution-context/runner-lock.js')

function tarEntry(name: string, content: string) {
	const data = Buffer.from(content)
	const header = Buffer.alloc(512)
	header.write(name, 0)
	header.write('0000644\0', 100)
	header.write('0000000\0', 108)
	header.write('0000000\0', 116)
	header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
	header.write('00000000000\0', 136)
	header.write('        ', 148)
	header.write('0', 156)
	header.write('ustar\0', 257)
	header.write('00', 263)
	let sum = 0
	for (const byte of header) sum += byte
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
	return Buffer.concat([
		header,
		data,
		Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length),
	])
}

function cliTarball(version: string, files: Record<string, string> = {}) {
	return gzipSync(
		Buffer.concat([
			tarEntry(
				'package/package.json',
				JSON.stringify({ name: '@kodycodes/cli', version }),
			),
			tarEntry('package/dist/bin.js', `console.log('${version}')\n`),
			...Object.entries(files).map(([name, text]) => tarEntry(name, text)),
			Buffer.alloc(1024),
		]),
	)
}

const integrityOf = (bytes: Buffer) =>
	`sha512-${createHash('sha512').update(bytes).digest('base64')}`

function registry(input: {
	version: string
	tarball?: Buffer
	integrity?: string
	counts?: { meta: number; tarball: number }
}) {
	const tarball = input.tarball ?? cliTarball(input.version)
	return (async (url: string | URL) => {
		const href = String(url)
		if (href.endsWith('/@kodycodes%2Fcli/latest')) {
			if (input.counts) input.counts.meta += 1
			return Response.json({
				name: '@kodycodes/cli',
				version: input.version,
				dist: {
					tarball: `https://registry.npmjs.org/@kodycodes/cli/-/cli-${input.version}.tgz`,
					integrity: input.integrity ?? integrityOf(tarball),
				},
			})
		}
		if (href.endsWith(`cli-${input.version}.tgz`)) {
			if (input.counts) input.counts.tarball += 1
			return new Response(tarball)
		}
		return new Response('not found', { status: 404 })
	}) as typeof fetch
}

const smokeOk = (entry: string) => ({
	ok: true,
	output: `${JSON.parse(readFileSync(join(entry, '..', '..', 'package.json'), 'utf8')).version}\n`,
})
// The running CLI install whose dependencies a new version reuses.
const runningRoot = mkdtempSync(join(tmpdir(), 'kody-running-cli-'))
mkdirSync(join(runningRoot, 'dist'))
writeFileSync(
	join(runningRoot, 'package.json'),
	JSON.stringify({ name: '@kodycodes/cli', version: '3.11.0' }),
)
writeFileSync(join(runningRoot, 'dist', 'bin.js'), '')
const deps = {
	smokeTest: smokeOk,
	runningEntry: join(runningRoot, 'dist', 'bin.js'),
	npmInstall: () => ({ ok: false, output: 'npm should not be needed' }),
}

/** A path under a regular file: creating anything in it fails. */
function writeBlocker() {
	const file = join(mkdtempSync(join(tmpdir(), 'kody-blocker-')), 'file')
	writeFileSync(file, '')
	return file
}

function freshStore() {
	return mkdtempSync(join(tmpdir(), 'kody-cli-store-'))
}

test('versions compare numerically and npm ranges resolve the way npm does', () => {
	assert.ok(update.isNewer('3.16.1', '3.11.0'))
	assert.ok(update.isNewer('3.10.0', '3.9.9'))
	assert.ok(!update.isNewer('3.11.0', '3.16.1'))
	assert.ok(!update.isNewer('3.16.1', '3.16.1'))
	assert.ok(update.isNewer('3.17.0', '3.17.0-beta.1'))
	assert.ok(update.satisfies('1.4.2', '^1.2.0'))
	assert.ok(!update.satisfies('2.0.0', '^1.2.0'))
	assert.ok(update.satisfies('0.3.5', '^0.3.1'))
	assert.ok(!update.satisfies('0.4.0', '^0.3.1'))
	assert.ok(update.satisfies('1.2.9', '~1.2.3'))
	assert.ok(!update.satisfies('1.3.0', '~1.2.3'))
	assert.ok(update.satisfies('1.2.3', '1.2.3'))
})

test('an update check installs the verified newer version and marks it current', async () => {
	const store = freshStore()
	const result = await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1' }),
		deps,
	})
	assert.equal(result.kind, 'ready')
	const current = update.readCurrent(store)
	assert.equal(current?.version, '3.16.1')
	assert.ok(existsSync(current!.entry))
	assert.equal(
		update.newerInstalledVersion({ selfVersion: '3.11.0', store })?.version,
		'3.16.1',
	)
	assert.equal(
		update.readUpdateState(store).history?.at(-1)?.outcome,
		'installed',
	)
	// Another daemon on the same machine hands off without downloading again.
	const counts = { meta: 0, tarball: 0 }
	const again = await update.checkForUpdate({
		selfVersion: '3.12.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1', counts }),
		deps,
	})
	assert.equal(again.kind, 'ready')
	assert.deepEqual(counts, { meta: 0, tarball: 0 })
})

test('never downgrades: an older or equal latest leaves the daemon alone', async () => {
	const store = freshStore()
	for (const version of ['3.10.0', '3.11.0']) {
		const counts = { meta: 0, tarball: 0 }
		const result = await update.checkForUpdate({
			selfVersion: '3.11.0',
			enabled: true,
			store,
			fetchFn: registry({ version, counts }),
			deps,
		})
		assert.deepEqual(result, { kind: 'up-to-date', latest: version })
		assert.equal(counts.tarball, 0)
	}
	assert.equal(update.readCurrent(store), null)
	// An installed copy older than the running daemon is never handed off to.
	await update.checkForUpdate({
		selfVersion: '3.0.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.5.0' }),
		deps,
	})
	assert.equal(
		update.newerInstalledVersion({ selfVersion: '3.11.0', store }),
		null,
	)
	// And a newer install is never replaced by an older one.
	await update.checkForUpdate({
		selfVersion: '3.6.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.9.0' }),
		deps,
	})
	const older = cliTarball('3.6.0')
	await update.installVersion({
		store,
		published: {
			version: '3.6.0',
			tarball: 'https://registry.npmjs.org/x.tgz',
			integrity: integrityOf(older),
		},
		tarball: older,
		deps,
	})
	assert.equal(update.readCurrent(store)?.version, '3.9.0')
})

test('a failed update keeps the old version and backs off', async () => {
	const store = freshStore()
	const counts = { meta: 0, tarball: 0 }
	const bad = await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({
			version: '3.16.1',
			integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
			counts,
		}),
		deps,
	})
	assert.equal(bad.kind, 'failed')
	assert.match((bad as { error: string }).error, /integrity mismatch/)
	assert.equal(update.readCurrent(store), null)
	const state = update.readUpdateState(store)
	assert.equal(state.failures?.['3.16.1']?.count, 1)
	assert.equal(state.history?.at(-1)?.outcome, 'failed')
	const retry = await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1', counts }),
		deps,
	})
	assert.equal(retry.kind, 'backoff')
	assert.equal(counts.tarball, 1, 'no download during backoff')
	// A version that does not start is not made current either.
	const later = Date.now() + 3 * 24 * 3_600_000
	const broken = await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1' }),
		deps: { ...deps, smokeTest: () => ({ ok: false, output: 'boom' }) },
		now: () => later,
	})
	assert.equal(broken.kind, 'failed')
	assert.match((broken as { error: string }).error, /did not start/)
	assert.equal(update.readCurrent(store), null)
	assert.ok(!existsSync(join(store, 'versions', '3.16.1')))
	assert.equal(update.backoffMs(1), 3_600_000)
	assert.equal(update.backoffMs(10), 24 * 3_600_000)
})

test('a tarball path outside the package is refused', () => {
	const dest = mkdtempSync(join(tmpdir(), 'kody-extract-'))
	assert.throws(
		() =>
			update.extractPackage(
				cliTarball('1.0.0', { 'package/../../evil.js': 'x' }),
				dest,
			),
		/unsafe path/,
	)
})

test('the off switch is stored in the local policy and wins everywhere', async () => {
	const policyPath = join(configHome, 'policy-test.json')
	writeFileSync(
		policyPath,
		JSON.stringify({ version: 1, fs: [{ path: '/tmp', mode: 'ro' }] }),
	)
	assert.deepEqual(
		update.autoUpdateSetting(await fsAccess.readLocalPolicy(policyPath), {}),
		{ enabled: true, source: 'default' },
	)
	await fsAccess.setLocalAutoUpdateEnabled({ enabled: false, policyPath })
	const policy = await fsAccess.readLocalPolicy(policyPath)
	assert.equal(policy.fs.length, 1, 'other policy entries are kept')
	assert.equal(update.autoUpdateSetting(policy, {}).enabled, false)
	assert.equal(
		update.autoUpdateSetting(null, { KODY_DAEMON_AUTO_UPDATE: '0' }).source,
		'env',
	)
	const counts = { meta: 0, tarball: 0 }
	const result = await update.checkForUpdate({
		selfVersion: '1.0.0',
		enabled: false,
		store: freshStore(),
		fetchFn: registry({ version: '2.0.0', counts }),
	})
	assert.deepEqual(result, { kind: 'disabled' })
	assert.deepEqual(counts, { meta: 0, tarball: 0 })
	await fsAccess.allowLocalPath({ path: '/var', mode: 'ro', policyPath })
	assert.equal(
		(await fsAccess.readLocalPolicy(policyPath)).autoUpdate?.enabled,
		false,
		'editing folders keeps the switch',
	)
})

test('the updater waits for runs and background commands before relaunching', async () => {
	const store = freshStore()
	const busy = { runs: 1, background: 1 }
	const lines: Array<string> = []
	let readyAt = 0
	const ready = new Promise<string>((resolve) => {
		const updater = update.startDaemonUpdater({
			selfVersion: '3.11.0',
			setting: async () => ({ enabled: true, source: 'default' }),
			busy: () => busy,
			log: (line) => lines.push(line),
			onReady: (current) => {
				readyAt = Date.now()
				resolve(current.version)
			},
			store,
			fetchFn: registry({ version: '3.16.1' }),
			deps,
			firstDelayMs: 0,
			idlePollMs: 20,
		})
		void updater
	})
	await new Promise((resolve) => setTimeout(resolve, 200))
	assert.equal(readyAt, 0, 'not while a run is in flight')
	busy.runs = 0
	await new Promise((resolve) => setTimeout(resolve, 100))
	assert.equal(readyAt, 0, 'not while a background command runs')
	const releasedAt = Date.now()
	busy.background = 0
	assert.equal(await ready, '3.16.1')
	assert.ok(readyAt >= releasedAt)
	assert.match(
		lines.join('\n'),
		/Waiting for 1 run\(s\) and 1 background command\(s\)/,
	)
	assert.match(lines.join('\n'), /updating kody 3\.11\.0 to 3\.16\.1/)

	const off: Array<string> = []
	let called = false
	const disabled = update.startDaemonUpdater({
		selfVersion: '3.11.0',
		setting: async () => ({ enabled: false, source: 'policy' }),
		busy: () => ({ runs: 0, background: 0 }),
		log: (line) => off.push(line),
		onReady: () => {
			called = true
		},
		store: freshStore(),
		fetchFn: registry({ version: '3.16.1' }),
		firstDelayMs: 0,
	})
	assert.deepEqual(await disabled.checkNow(), { kind: 'disabled' })
	disabled.stop()
	assert.equal(called, false)
	assert.match(off.join('\n'), /Auto-update is off/)
})

class FakeChild extends EventEmitter {
	kill() {
		return true
	}
}

test('the supervisor relaunches onto newer versions and falls back when one crashes', async () => {
	const store = freshStore()
	await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1' }),
		deps,
	})
	const first = update.readCurrent(store)!
	const launched: Array<string> = []
	const codes = [update.relaunchExitCode, 0]
	const outcome = await update.superviseNewerVersion({
		first,
		selfVersion: '3.11.0',
		args: ['daemon', '--context', 'ec_x'],
		log: () => {},
		store,
		spawnFn: ((_cmd: string, args: Array<string>) => {
			launched.push(args[0]!)
			const child = new FakeChild()
			const code = codes.shift()
			setTimeout(() => child.emit('exit', code, null), 5)
			return child
		}) as never,
	})
	assert.deepEqual(outcome, { kind: 'exit', code: 0 })
	assert.equal(launched.length, 2)
	assert.ok(launched.every((entry) => entry === first.entry))

	const lines: Array<string> = []
	const fallback = await update.superviseNewerVersion({
		first,
		selfVersion: '3.11.0',
		args: [],
		log: (line) => lines.push(line),
		store,
		spawnFn: (() => {
			const child = new FakeChild()
			setTimeout(() => child.emit('exit', 1, null), 5)
			return child
		}) as never,
	})
	assert.deepEqual(fallback, { kind: 'fallback' })
	assert.match(lines.join('\n'), /Staying on 3\.11\.0/)
	assert.equal(
		update.newerInstalledVersion({ selfVersion: '3.11.0', store }),
		null,
		'a version that crashed on start is not retried right away',
	)
})

test('one runner per context: a second daemon is refused and names the first', () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-runner-lock-'))
	mkdirSync(dir, { recursive: true })
	const path = lock.lockPathFor(join(dir, 'daemon.json'))
	const first = lock.acquireRunnerLock(path, {
		version: '3.16.1',
		launcher: 'launchd',
		startedAt: new Date().toISOString(),
	})
	assert.ok(first.ok)
	const second = lock.acquireRunnerLock(path, {
		pid: process.pid + 100_000,
		version: '3.16.1',
		launcher: 'desktop',
		startedAt: new Date().toISOString(),
	})
	assert.equal(second.ok, false)
	assert.equal(!second.ok && second.holder.launcher, 'launchd')
	assert.match(
		lock.describeHolder(!second.ok ? second.holder : (null as never)),
		/the launchd service/,
	)
	assert.equal(lock.runnerLockHolder(path)?.pid, process.pid)
	if (first.ok) first.release()
	assert.equal(lock.runnerLockHolder(path), null)
	// A lock left by a crashed daemon is taken over.
	writeFileSync(
		path,
		JSON.stringify({
			pid: 2 ** 22 + 12345,
			version: '1.0.0',
			launcher: 'terminal',
			startedAt: '',
		}),
	)
	const taken = lock.acquireRunnerLock(path, {
		version: '3.16.1',
		launcher: 'terminal',
		startedAt: '',
	})
	assert.ok(taken.ok)
})

test('old daemons without the lock are found by command line', async () => {
	const others = await lock.otherLocalDaemons({
		ecid: 'ec_abc',
		listProcesses: async () => [
			{
				pid: 11,
				cmd: 'node /usr/lib/node_modules/@kodycodes/cli/dist/bin.js daemon --context ec_abc',
			},
			{
				pid: 12,
				cmd: 'npm exec @kodycodes/cli@latest daemon --context ec_other',
			},
			{ pid: 13, cmd: 'vim daemon ec_abc.txt' },
		],
	})
	assert.deepEqual(
		others.map((other) => other.pid),
		[11],
	)
})

test('a startup refusal (lock held, offline) does not count against the version', async () => {
	const store = freshStore()
	await update.checkForUpdate({
		selfVersion: '3.11.0',
		enabled: true,
		store,
		fetchFn: registry({ version: '3.16.1' }),
		deps,
	})
	const first = update.readCurrent(store)!
	for (let i = 0; i < 4; i++) {
		const outcome = await update.superviseNewerVersion({
			first,
			selfVersion: '3.11.0',
			args: [],
			log: () => {},
			store,
			spawnFn: (() => {
				const child = new FakeChild()
				setTimeout(
					() => child.emit('exit', update.startupRefusedExitCode, null),
					5,
				)
				return child
			}) as never,
		})
		assert.deepEqual(outcome, { kind: 'exit', code: 1 })
	}
	assert.equal(
		update.newerInstalledVersion({ selfVersion: '3.11.0', store })?.version,
		'3.16.1',
	)
})

test('a failing check is logged and retried instead of stopping the updater', async () => {
	const lines: Array<string> = []
	const updater = update.startDaemonUpdater({
		selfVersion: '3.11.0',
		setting: async () => ({ enabled: true, source: 'default' }),
		busy: () => ({ runs: 0, background: 0 }),
		log: (line) => lines.push(line),
		onReady: () => {},
		// A store path that cannot be created makes the check throw.
		store: join(writeBlocker(), 'store'),
		fetchFn: registry({ version: '3.16.1' }),
		deps,
		firstDelayMs: 0,
		intervalMs: 20,
	})
	await new Promise((resolve) => setTimeout(resolve, 200))
	updater.stop()
	assert.match(lines.join('\n'), /Auto-update: check failed/)
	assert.ok(
		lines.filter((line) => line.includes('check failed')).length >= 2,
		'it keeps checking on schedule',
	)
})

test('the idle deadline forces the update and says so', async () => {
	const store = freshStore()
	const forcedFlags: Array<boolean> = []
	const done = new Promise<void>((resolve) => {
		const updater = update.startDaemonUpdater({
			selfVersion: '3.11.0',
			setting: async () => ({ enabled: true, source: 'default' }),
			busy: () => ({ runs: 0, background: 1 }),
			log: () => {},
			onReady: (_current, forced) => {
				forcedFlags.push(forced)
				updater.stop()
				resolve()
			},
			store,
			fetchFn: registry({ version: '3.16.1' }),
			deps,
			firstDelayMs: 0,
			idlePollMs: 5,
			maxIdleWaitMs: 30,
		})
	})
	await done
	assert.deepEqual(forcedFlags, [true])
})

test('a lock whose pid now belongs to another process, or predates boot, is taken over', () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-lock-'))
	const path = lock.lockPathFor(join(dir, 'daemon.json'))
	const holder = {
		pid: 4242,
		version: '3.16.1',
		launcher: 'launchd' as const,
		startedAt: new Date().toISOString(),
	}
	const alive = { isAlive: (pid: number) => pid === 4242 }
	writeFileSync(path, JSON.stringify(holder))
	assert.equal(
		lock.runnerLockHolder(path, { ...alive, commandOf: () => '/usr/bin/vim' }),
		null,
		'a reused pid running something else is not a runner',
	)
	const asDaemon = {
		...alive,
		commandOf: () => 'node kody daemon --context ec',
	}
	assert.equal(lock.runnerLockHolder(path, asDaemon)?.pid, 4242)
	assert.equal(
		lock.acquireRunnerLock(
			path,
			{ version: '3.17.0', launcher: 'terminal', startedAt: '' },
			asDaemon,
		).ok,
		false,
	)
	assert.equal(
		lock.runnerLockHolder(path, {
			...asDaemon,
			bootTimeMs: Date.now() + 120_000,
		}),
		null,
		'a lock written before this boot is stale',
	)
	const taken = lock.acquireRunnerLock(
		path,
		{
			version: '3.17.0',
			launcher: 'terminal',
			startedAt: new Date().toISOString(),
		},
		{ ...alive, commandOf: () => '/usr/bin/vim' },
	)
	assert.ok(taken.ok)
	assert.equal(lock.runnerLockHolder(path)?.pid, process.pid)
	if (taken.ok) taken.release()
	// A lock file another daemon is still writing is not reaped.
	writeFileSync(path, '')
	const young = lock.acquireRunnerLock(path, {
		version: '3.17.0',
		launcher: 'terminal',
		startedAt: '',
	})
	assert.equal(young.ok, false)
	assert.match(
		lock.describeHolder(!young.ok ? young.holder : (null as never)),
		/taking the lock right now/,
	)
	// A lock this user cannot read (another user's daemon) is never reclaimed.
	if (process.getuid?.() !== 0) {
		writeFileSync(path, '{}')
		utimesSync(path, new Date(0), new Date(0))
		chmodSync(path, 0o000)
		try {
			const unreadable = lock.acquireRunnerLock(path, {
				version: '3.17.0',
				launcher: 'terminal',
				startedAt: '',
			})
			assert.equal(unreadable.ok, false)
			assert.match(
				lock.describeHolder(
					!unreadable.ok ? unreadable.holder : (null as never),
				),
				/another user/,
			)
		} finally {
			chmodSync(path, 0o600)
		}
	}
})

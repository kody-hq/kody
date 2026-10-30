import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import psList from 'ps-list'
import {
	formatDevEvent,
	parseWorkerdStdoutLine,
	runtimeErrorFix,
} from '../src/dev/dev-events.js'
import { appLogMarker } from '../src/dev/dev-protocol.js'
import { shouldIgnoreWatchPath } from '../src/dev/dev-watcher.js'
import {
	isProcessAlive,
	startProcessReaper,
	sweepStaleDevDirs,
} from '../src/dev/process-reaper.js'
import { createStackMapper } from '../src/dev/stack-trace.js'
import { cleanWorkerdStderrLine } from '../src/dev/workerd-process.js'
import { waitFor, withDevServer } from './dev-server-harness.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('kody dev swaps workerd without a 503 and recovers from build errors', async () => {
	await withDevServer(async ({ server, events, writeMessage }) => {
		const first = await server.fetchPath('/')
		assert.equal(first.status, 200)
		assert.match(first.body, /v0/)

		let polling = true
		const statuses: Array<number> = []
		const poller = (async () => {
			while (polling) {
				statuses.push((await server.fetchPath('/')).status)
			}
		})()
		for (let i = 1; i <= 3; i += 1) {
			await writeMessage(`export const message = 'v${i}'\n`)
			await waitFor(async () => {
				const response = await server.fetchPath('/')
				return response.body.includes(`v${i}`) ? true : undefined
			}, `v${i}`)
		}
		polling = false
		await poller
		assert.ok(statuses.length > 0)
		assert.deepEqual(
			statuses.filter((status) => status !== 200),
			[],
			'no request may fail while a rebuild swaps workerd',
		)

		await writeMessage(`export const message = = 'broken'\n`)
		const broken = await waitFor(async () => {
			const response = await server.fetchPath('/')
			return response.status === 500 ? response : undefined
		}, 'build error page')
		assert.equal(broken.headers['x-kody-dev-error'], 'build')
		assert.match(broken.body, /app\/message\.ts:1:24: Unexpected "="/)
		assert.match(broken.body, /\| export const message = = 'broken'/)
		assert.doesNotMatch(broken.body, /for local execute/)
		const buildError = events.find((event) => event.type === 'build_error')
		assert.ok(buildError && buildError.type === 'build_error')
		assert.equal(buildError.file, 'app/message.ts')
		assert.equal(buildError.line, 1)
		assert.equal(buildError.col, 24)

		await writeMessage(`export const message = 'fixed'\n`)
		await waitFor(async () => {
			const response = await server.fetchPath('/')
			return response.status === 200 && response.body.includes('fixed')
				? true
				: undefined
		}, 'recovery after a build error')
		assert.ok(
			events.some((event) => event.type === 'rebuild_ok' && event.restarted),
		)
	})
})

test('a save just before close never starts a rebuild after close', async () => {
	await withDevServer(
		async ({ server, events, writeMessage }) => {
			await writeMessage(`export const message = 'late'\n`)
			await sleep(120)
			await server.close()
			const seen = events.length
			await sleep(500)
			assert.deepEqual(
				events.slice(seen),
				[],
				'the pending debounce must not rebuild',
			)
		},
		{ debounceMs: 300 },
	)
})

test('kody dev streams tagged console logs and source-maps runtime errors', async () => {
	await withDevServer(async ({ server, events }) => {
		const html = await server.fetchPath('/boom', {
			headers: { accept: 'text/html' },
		})
		assert.equal(html.status, 500)
		assert.match(html.headers['content-type'] ?? '', /text\/html/)
		assert.match(html.body, /Runtime error/)
		assert.match(html.body, /app\/entry\.ts:7:/)

		const text = await server.fetchPath('/boom')
		assert.equal(text.status, 500)
		assert.match(text.body, /^kody dev runtime error \(GET \/boom\)/)
		assert.match(text.body, /Error: kaboom\n\s+at .*app\/entry\.ts:7:\d+/)
		assert.doesNotMatch(text.body, /main\.js|__kody_local_entry|workerd@/)

		const runtimeError = await waitFor(
			async () => events.find((event) => event.type === 'runtime_error'),
			'runtime_error event',
		)
		assert.ok(runtimeError.type === 'runtime_error')
		assert.equal(runtimeError.request?.path, '/boom')

		const log = await waitFor(
			async () =>
				events.find(
					(event) =>
						event.type === 'log' && event.message.includes('handling /boom'),
				),
			'app console.log',
		)
		assert.ok(log.type === 'log')
		assert.equal(log.source, 'app')
		assert.match(log.message, /handling \/boom \{ n: 1 \}/)
		assert.equal(log.request?.method, 'GET')
		assert.equal(log.request?.path, '/boom')
		assert.match(formatDevEvent(log).text, /^\[GET \/boom #\d+\] handling/)
	})
})

test('createStackMapper maps bundle frames to sources and drops runtime frames', () => {
	// Line 1 of main.js maps to app/entry.ts:7:11 (VLQ "AAMU" = [0,0,6,10]).
	const sourceMap = JSON.stringify({
		version: 3,
		sources: ['app/entry.ts'],
		names: [],
		mappings: 'AAMU',
	})
	const mapper = createStackMapper({ sourceMap, userModule: 'main.js' })
	const mapped = mapper(
		[
			'Error: kaboom',
			'    at Object.fetch (main.js:1:1)',
			'    at __kodyRunInLocalRuntime (kody:runtime:12:3)',
			'    at Object.fetch (__kody_local_entry.js:40:5)',
			'    at async Promise.all (index 0)',
			'    at kody:@scope/pkg/export:3:9',
		].join('\n'),
	)
	assert.equal(
		mapped,
		[
			'Error: kaboom',
			'    at Object.fetch (app/entry.ts:7:11)',
			'    at kody:@scope/pkg/export:3:9',
		].join('\n'),
	)
})

test('cleanWorkerdStderrLine strips native addresses and C++ prefixes', () => {
	assert.equal(
		cleanWorkerdStderrLine(
			'stack: /x/workerd@33a76d0 /x/workerd@33a836c /x/workerd@58b85c8',
		),
		null,
	)
	assert.equal(
		cleanWorkerdStderrLine(
			'workerd/server/server.c++:6557: error: Uncaught exception: workerd/jsg/value.h:1477: failed: remote.jsg.Error: probe boom',
		),
		'Uncaught exception: Error: probe boom',
	)
	assert.equal(cleanWorkerdStderrLine('plain stderr'), 'plain stderr')
})

test('parseWorkerdStdoutLine reads tagged app logs and passes plain lines through', () => {
	const tagged = parseWorkerdStdoutLine(
		`${appLogMarker}${JSON.stringify({ level: 'warn', message: 'careful', request: { id: '3', method: 'POST', path: '/x' } })}`,
	)
	assert.deepEqual(tagged, {
		type: 'log',
		source: 'app',
		level: 'warn',
		message: 'careful',
		request: { id: '3', method: 'POST', path: '/x' },
	})
	assert.deepEqual(parseWorkerdStdoutLine('hello'), {
		type: 'log',
		source: 'app',
		level: 'log',
		message: 'hello',
		request: null,
	})
})

test('runtime errors from a CommonJS require() of a Node builtin carry a fix line', () => {
	const message = 'Error: Dynamic require of "util" is not supported'
	const fix = runtimeErrorFix(message)
	assert.match(fix ?? '', /require\("util"\)/)
	assert.match(fix ?? '', /edge/)
	assert.equal(runtimeErrorFix('Error: boom'), undefined)
	const text = formatDevEvent({
		type: 'runtime_error',
		message,
		stack: message,
		request: { id: '1', method: 'GET', path: '/' },
		fix,
	}).text
	assert.match(text, /^\[GET \/ #1\] Uncaught Error: Dynamic require/)
	assert.match(text, /\nfix: A CommonJS dependency/)
})

test('shouldIgnoreWatchPath skips dependencies, dotfiles, maps, and custom prefixes', () => {
	assert.equal(shouldIgnoreWatchPath('app/entry.ts'), false)
	assert.equal(shouldIgnoreWatchPath('node_modules/x/index.js'), true)
	assert.equal(shouldIgnoreWatchPath('.git/HEAD'), true)
	assert.equal(shouldIgnoreWatchPath('app/.cache/file'), true)
	assert.equal(shouldIgnoreWatchPath('dist/app.js.map'), true)
	assert.equal(
		shouldIgnoreWatchPath('public/generated/a.css', ['public/generated']),
		true,
	)
	assert.equal(
		shouldIgnoreWatchPath('public/generator.ts', ['public/generated']),
		false,
	)
})

test('process reaper kills tracked pids and removes the work dir when its pipe closes', async () => {
	const workDir = await mkdtemp(join(tmpdir(), 'kody-dev-reaper-test-'))
	const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
	assert.ok(sleeper.pid)
	const exited = new Promise<void>((resolve) =>
		sleeper.once('exit', () => resolve()),
	)
	const reaper = await startProcessReaper({ workDir })
	reaper.track(sleeper.pid)
	reaper.close()
	await Promise.race([
		exited,
		new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
	])
	assert.equal(isProcessAlive(sleeper.pid), false)
	await waitFor(
		async () =>
			(await readdir(tmpdir())).includes(workDir.split('/').pop()!)
				? undefined
				: true,
		'work dir removal',
	)
})

// The grandchild is reparented to PID 1, which may not reap it in a container
// without an init process; a zombie still answers kill(pid, 0).
function isLiveNonZombie(pid: number) {
	if (!isProcessAlive(pid)) return false
	if (process.platform !== 'linux') return true
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
		return (
			stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
		)
	} catch {
		// Exited between the probes, or /proc is unreadable: trust kill(pid, 0).
		return isProcessAlive(pid)
	}
}

test('process reaper kills a detached process group on pipe close', async () => {
	const workDir = await mkdtemp(join(tmpdir(), 'kody-dev-reaper-group-'))
	// Nested sleep under detached sh — killing only the shell would leave the child.
	const shell = spawn('sh', ['-c', 'sleep 30 & wait'], {
		stdio: 'ignore',
		detached: true,
	})
	assert.ok(shell.pid)
	shell.unref()
	const childPid = await waitFor(async () => {
		const listed = await psList()
		const child = listed.find(
			(item) => item.ppid === shell.pid && /sleep/.test(item.name),
		)
		return child?.pid
	}, 'detached sleep grandchild')
	const reaper = await startProcessReaper({ workDir })
	reaper.trackGroup(shell.pid)
	reaper.close()
	await waitFor(async () => {
		if (isLiveNonZombie(shell.pid!) || isLiveNonZombie(childPid))
			return undefined
		return true
	}, 'detached process group death')
	await waitFor(
		async () =>
			(await readdir(tmpdir())).includes(workDir.split('/').pop()!)
				? undefined
				: true,
		'work dir removal',
	)
})

test('sweepStaleDevDirs reaps dirs of dead owners and legacy orphans only', async () => {
	const tmp = await mkdtemp(join(tmpdir(), 'kody-dev-sweep-'))
	try {
		const make = async (name: string, owner?: number, ageMs = 0) => {
			const dir = join(tmp, name)
			await mkdir(dir)
			if (owner !== undefined)
				await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid: owner }))
			const when = new Date(Date.now() - ageMs)
			await utimes(dir, when, when)
			return dir
		}
		const live = await make('kody-dev-live', 100)
		const dead = await make('kody-dev-dead', 200)
		const legacyOrphan = await make(
			'kody-dev-legacy-orphan',
			undefined,
			3_600_000,
		)
		const legacyActive = await make(
			'kody-dev-legacy-active',
			undefined,
			3_600_000,
		)
		const legacyFresh = await make('kody-dev-legacy-fresh')
		const killed: Array<number> = []
		const result = await sweepStaleDevDirs({
			tmp,
			isAlive: (pid) => pid === 100 || pid === 500,
			kill: (pid) => killed.push(pid),
			listProcesses: async () => [
				{
					pid: 11,
					ppid: 100,
					name: 'workerd',
					cmd: `workerd serve ${live}/g1/config.capnp`,
				},
				{
					pid: 12,
					ppid: 1,
					name: 'workerd',
					cmd: `workerd serve ${dead}/g1/config.capnp`,
				},
				{
					pid: 13,
					ppid: 1,
					name: 'workerd',
					cmd: `workerd serve ${legacyOrphan}/config.capnp`,
				},
				{
					pid: 14,
					ppid: 500,
					name: 'workerd',
					cmd: `workerd serve ${legacyActive}/config.capnp`,
				},
				{ pid: 500, ppid: 1, name: 'node', cmd: 'node kody dev' },
			],
		})
		assert.deepEqual(killed.sort(), [12, 13])
		assert.deepEqual(result.removed.sort(), [dead, legacyOrphan].sort())
		const left = (await readdir(tmp)).sort()
		assert.deepEqual(left, [
			'kody-dev-legacy-active',
			'kody-dev-legacy-fresh',
			'kody-dev-live',
		])
		void legacyFresh
	} finally {
		await rm(tmp, { recursive: true, force: true })
	}
})

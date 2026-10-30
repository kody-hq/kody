import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
	createLocalWorkerTracker,
	reapLeftoverWorkers,
} from '../src/execution-context/worker-tracker.js'

function isRunning(pid: number) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitUntil(label: string, check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return
		await delay(50)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

/** A long-lived process whose command line names `configPath`, like workerd. */
function fakeWorkerd(configPath: string): ChildProcess {
	return spawn(
		process.execPath,
		['-e', 'setInterval(() => {}, 1e9)', configPath],
		{ stdio: 'ignore' },
	)
}

function runDir() {
	const root = mkdtempSync(join(tmpdir(), 'kody-tracker-'))
	const workDir = join(root, 'kody-local-run')
	mkdirSync(workDir)
	const configPath = join(workDir, 'config.capnp')
	writeFileSync(configPath, '')
	return { root, workDir, configPath, workersDir: join(root, 'workers') }
}

test('startup reaping kills a workerd left by a crashed daemon and removes its files', async () => {
	const { workDir, configPath, workersDir } = runDir()
	const worker = fakeWorkerd(configPath)
	const pid = worker.pid!
	mkdirSync(workersDir)
	// The owner daemon is gone (a pid that cannot exist).
	writeFileSync(
		join(workersDir, `${pid}.json`),
		JSON.stringify({ pid, configPath, ownerPid: 2 ** 22 + 1 }),
	)
	await waitUntil('the fake workerd', () => isRunning(pid))

	assert.deepEqual(reapLeftoverWorkers(workersDir), [pid])
	await waitUntil('the leftover workerd to stop', () => !isRunning(pid))
	assert.equal(existsSync(workDir), false)
	assert.deepEqual(readdirSync(workersDir), [])
})

test('startup reaping leaves a reused pid and a live daemon’s workers alone', async () => {
	const { configPath, workersDir } = runDir()
	const unrelated = fakeWorkerd(join(tmpdir(), 'some-other', 'config.capnp'))
	const unrelatedPid = unrelated.pid!
	const owned = fakeWorkerd(configPath)
	const ownedPid = owned.pid!
	try {
		mkdirSync(workersDir)
		writeFileSync(
			join(workersDir, `${unrelatedPid}.json`),
			JSON.stringify({
				pid: unrelatedPid,
				configPath,
				ownerPid: 2 ** 22 + 1,
			}),
		)
		// Owned by this test process, which is still running.
		writeFileSync(
			join(workersDir, `${ownedPid}.json`),
			JSON.stringify({ pid: ownedPid, configPath, ownerPid: process.pid }),
		)
		writeFileSync(join(workersDir, 'garbage.json'), 'not json')
		await waitUntil('the fake workers', () =>
			[unrelatedPid, ownedPid].every(isRunning),
		)

		assert.deepEqual(reapLeftoverWorkers(workersDir, { selfPid: 1 }), [])
		await delay(200)
		assert.ok(isRunning(unrelatedPid))
		assert.ok(isRunning(ownedPid))
		assert.deepEqual(readdirSync(workersDir), [`${ownedPid}.json`])
	} finally {
		unrelated.kill('SIGKILL')
		owned.kill('SIGKILL')
	}
})

test('a daemon that exits kills the workers it is still tracking', async () => {
	const { configPath, workersDir } = runDir()
	const trackerModule = fileURLToPath(
		new URL('../src/execution-context/worker-tracker.ts', import.meta.url),
	)
	const script = `
import { spawn } from 'node:child_process'
import { createLocalWorkerTracker } from ${JSON.stringify(trackerModule)}
const tracker = createLocalWorkerTracker(${JSON.stringify(workersDir)})
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', ${JSON.stringify(configPath)}], { stdio: 'ignore' })
tracker.started({ pid: worker.pid, configPath: ${JSON.stringify(configPath)} })
console.log(worker.pid)
setTimeout(() => process.exit(1), 300)
`
	const daemon = spawn(
		process.execPath,
		['--import', 'tsx', '--input-type=module', '-e', script],
		{ stdio: ['ignore', 'pipe', 'inherit'] },
	)
	let stdout = ''
	daemon.stdout!.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8')
	})
	await new Promise((resolve) => daemon.once('exit', resolve))
	const pid = Number(stdout.trim())
	assert.ok(pid > 0)
	await waitUntil('the tracked workerd to stop', () => !isRunning(pid))
	assert.deepEqual(readdirSync(workersDir), [])
})

test('a tracker forgets a worker once it exits on its own', () => {
	const { workersDir, configPath } = runDir()
	const killed: Array<number> = []
	const tracker = createLocalWorkerTracker(workersDir, {
		ops: { kill: (pid) => killed.push(pid) },
	})
	try {
		tracker.started({ pid: 101, configPath })
		tracker.started({ pid: 102, configPath })
		assert.deepEqual(readdirSync(workersDir).sort(), ['101.json', '102.json'])
		tracker.exited(101)
		tracker.killAll()
		assert.deepEqual(killed, [102])
		assert.deepEqual(readdirSync(workersDir), [])
	} finally {
		tracker.dispose()
	}
})

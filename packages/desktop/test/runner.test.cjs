const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { join } = require('node:path')
const { test } = require('node:test')
const { Runner } = require('../runner.cjs')

class FixtureRunner extends Runner {
	launch(args) {
		if (this.closing) throw new Error('Kody is quitting.')
		const child = fork(join(__dirname, 'cli.fixture.cjs'), args, {
			silent: true,
			detached: process.platform !== 'win32',
			execArgv: [],
		})
		return this.trackChild(child)
	}
}

test('commands pass arguments without shell interpretation and surface CLI errors', async () => {
	const runner = new FixtureRunner()
	const name = 'my machine; $(touch nope)'
	assert.deepEqual(
		JSON.parse(await runner.command(['context', 'register', '--name', name])),
		['context', 'register', '--name', name],
	)
	await assert.rejects(runner.command(['fail']), /Registration refused/)
	await runner.close()
})

test(
	'stop ends the daemon and its workerd child, and start is idempotent',
	{ timeout: 90_000 },
	async () => {
		const runner = new FixtureRunner()
		try {
			runner.start('ec_test')
			const child = runner.daemon
			runner.start('ec_test')
			assert.equal(runner.daemon, child)
			await once(child.stdout, 'data')
			const workerPid = Number(runner.output.trim())
			assert.ok(workerPid > 0)
			await runner.stop()
			assert.equal(runner.daemon, null)
			assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' })
		} finally {
			await runner.close()
		}
	},
)

test('quit stops all CLI commands and prevents new launches', async () => {
	const runner = new FixtureRunner()
	const child = runner.launch(['wait'])
	await once(child.stdout, 'data')
	await runner.close()
	assert.equal(runner.children.size, 0)
	assert.throws(() => runner.launch(['context']), /quitting/)
})

test('production CLI host runs the bundled CLI without a terminal Node installation', async () => {
	const runner = new Runner()
	try {
		assert.match(await runner.command(['version']), /\d+\.\d+\.\d+/)
	} finally {
		await runner.close()
	}
})

test(
	'losing the desktop IPC owner stops the CLI and its worker',
	{ timeout: 90_000 },
	async () => {
		const runner = new FixtureRunner()
		const child = runner.launch(['daemon'])
		const [output] = await once(child.stdout, 'data')
		const workerPid = Number(output.toString().trim())
		const closed = once(child, 'exit')
		child.disconnect()
		await closed
		assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' })
		await runner.close()
	},
)

test(
	'a CLI crash cannot leave its worker running',
	{ timeout: 90_000 },
	async () => {
		const runner = new FixtureRunner()
		try {
			const child = runner.launch(['daemon'])
			const [output] = await once(child.stdout, 'data')
			const workerPid = Number(output.toString().trim())
			const closed = once(child, 'close')
			child.kill('SIGKILL')
			await closed
			const { setTimeout: delay } = require('node:timers/promises')
			let alive = true
			for (let attempt = 0; attempt < 400 && alive; attempt++) {
				try {
					process.kill(workerPid, 0)
					await delay(50)
				} catch (error) {
					assert.equal(error.code, 'ESRCH')
					alive = false
				}
			}
			assert.equal(alive, false)
		} finally {
			await runner.close()
		}
	},
)

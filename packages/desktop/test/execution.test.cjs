const assert = require('node:assert/strict')
const { test } = require('node:test')
const { DesktopExecution } = require('../execution.cjs')
function fixture(saved = {}) {
	let state = { ecid: null, enabled: false, ...saved }
	let viewer = { username: 'jane', email: 'jane@example.com', orgSlug: 'jane' }
	let identity = {
		user: { email: viewer.email },
		org: 'jane',
		scope: ['execution_context:create'],
		credential: { source: 'login' },
	}
	const calls = []
	// `kody daemon status --json`: nothing installed by the CLI by default.
	let machine = { installed: false, contexts: [], runner: null }
	const runner = {
		daemon: null,
		async command(args) {
			if (args[0] === 'daemon' && args[1] === 'status')
				return JSON.stringify(machine)
			calls.push(args)
			if (args[0] === 'login') return ''
			if (args[0] === 'whoami') return JSON.stringify(identity)
			if (args[1] === 'register') return JSON.stringify({ ecid: 'ec_test' })
			if (args[1] === 'list')
				return JSON.stringify({
					contexts: [
						{
							id: 'ec_old',
							name: 'old-laptop',
							operator: { handle: 'jane' },
							ownerOrg: { slug: 'jane' },
							status: 'offline',
						},
					],
				})
			if (args[0] === 'daemon') return '{"ok":true}'
			throw new Error('Unexpected command')
		},
		start(id) {
			calls.push(['start', id])
			this.daemon = {}
		},
		async stop() {
			calls.push(['stop'])
			this.daemon = null
		},
	}
	const execution = new DesktopExecution({
		runner,
		read: () => state,
		write: (next) => {
			state = next
		},
		viewer: async () => viewer,
		hostname: 'My-Mac.local',
		platform: 'darwin',
	})
	return {
		execution,
		runner,
		calls,
		state: () => state,
		viewer: (next) => {
			viewer = next
		},
		identity: (next) => {
			identity = { ...identity, ...next }
		},
		machine: (next) => {
			machine = { ...machine, ...next }
			execution.machineReadAt = 0
		},
	}
}
test('status never opens CLI login, and unsigned callers cannot register', async () => {
	const f = fixture()
	await f.execution.request('state')
	assert.deepEqual(f.calls, [])
	await assert.rejects(f.execution.request('connect', 'mac'), /Sign in/)
	f.viewer(null)
	await assert.rejects(f.execution.request('sign-in'), /Sign in to Kody/)
	assert.deepEqual(f.calls, [])
})
test('fixed registration uses the verified personal workspace and retries without duplicate contexts', async () => {
	const f = fixture()
	await f.execution.request('sign-in')
	await f.execution.request('connect', 'build-box')
	await f.execution.request('connect', 'build-box')
	assert.equal(f.calls.filter((args) => args[1] === 'register').length, 1)
	assert.deepEqual(
		f.calls.find((args) => args[1] === 'register'),
		['context', 'register', '--org', 'jane', '--name', 'build-box', '--json'],
	)
	assert.equal(f.state().name, 'build-box')
	assert.equal(f.state().enabled, true)
	await f.execution.request('complete')
	assert.deepEqual(f.state().onboardingSeen, ['jane'])
	await f.execution.request('stop')
	assert.equal(f.runner.daemon, null)
	assert.equal(f.state().enabled, false)
	await f.execution.request('start')
	assert.ok(f.runner.daemon)
})
test('CLI account mismatch and shadowing tokens fail before any registration', async () => {
	for (const identity of [
		{ user: { email: 'other@example.com' } },
		{ org: 'other' },
		{ credential: { source: 'stored-api-token' } },
	]) {
		const f = fixture()
		f.identity(identity)
		await assert.rejects(f.execution.request('sign-in'), /does not match/)
		assert.equal(f.state().ecid, null)
	}
})
test('account changes stop a previous runner and do not expose or mutate its registration', async () => {
	const f = fixture({
		ecid: 'ec_private',
		enabled: true,
		owner: { username: 'jane', orgSlug: 'jane' },
	})
	await f.execution.request('state')
	assert.ok(f.runner.daemon)
	f.viewer({ username: 'sam', email: 'sam@example.com', orgSlug: 'sam' })
	const result = await f.execution.request('state')
	assert.equal(result.contextId, null)
	assert.equal(result.blocked, true)
	assert.equal(f.runner.daemon, null)
	await assert.rejects(f.execution.request('start'), /another workspace/)
	assert.equal(f.state().ecid, 'ec_private')
})
test('legacy registrations require verified server ownership before adoption', async () => {
	const f = fixture({ ecid: 'ec_old', enabled: true })
	assert.equal((await f.execution.request('state')).needsVerification, true)
	assert.equal(f.runner.daemon, null)
	await f.execution.request('sign-in')
	assert.deepEqual(f.state().owner, { username: 'jane', orgSlug: 'jane' })
	assert.equal(f.state().name, 'old-laptop')
	const other = fixture({ ecid: 'ec_someone_else', enabled: true })
	await assert.rejects(other.execution.request('sign-in'), /does not belong/)
	assert.equal(other.state().owner, undefined)
})
test('invalid names and unknown actions cannot become CLI arguments', async () => {
	const f = fixture()
	await f.execution.request('sign-in')
	for (const name of [
		'--help',
		'hello;rm',
		'Uppercase',
		{},
		'',
		'x'.repeat(64),
	])
		await assert.rejects(f.execution.request('connect', name), /machine name/)
	await assert.rejects(
		f.execution.request('execute', ['anything']),
		/Unknown machine action/,
	)
	assert.equal(
		f.calls.some((args) => args[1] === 'register'),
		false,
	)
})
test('onboarding dismissal survives without registering or granting access', async () => {
	const f = fixture()
	await f.execution.request('dismiss')
	assert.equal((await f.execution.request('state')).onboardingSeen, true)
	assert.equal(f.state().ecid, null)
	assert.deepEqual(f.calls, [])
})
test('concurrent registration is rejected, including requests waiting on viewer verification', async () => {
	const f = fixture()
	await f.execution.request('sign-in')
	let finish
	f.runner.command = () =>
		new Promise((resolve) => {
			finish = resolve
		})
	const pending = f.execution.request('connect', 'mac')
	await new Promise((resolve) => setImmediate(resolve))
	await assert.rejects(f.execution.request('connect', 'mac'), /already running/)
	finish(
		JSON.stringify({
			user: { email: 'other@example.com' },
			scope: ['execution_context:create'],
			org: 'jane',
			credential: { source: 'login' },
		}),
	)
	await assert.rejects(pending, /does not match/)
})

test('forget stops execution and clears only this app selection, including a previous account or legacy setup', async () => {
	const f = fixture({
		ecid: 'ec_private',
		enabled: true,
		owner: { username: 'other', orgSlug: 'other' },
		onboardingSeen: ['other'],
	})
	f.runner.daemon = {}
	const result = await f.execution.request('forget')
	assert.equal(f.runner.daemon, null)
	assert.equal(result.hasSetup, false)
	assert.equal(result.onboardingSeen, true)
	assert.equal(f.state().ecid, null)
	assert.deepEqual(f.calls, [['stop']])
	assert.deepEqual(f.state().onboardingSeen, ['other', 'jane'])
	await assert.rejects(f.execution.request('connect', 'mac'), /Sign in/)
})

test('account changes during browser login never authorize registration', async () => {
	const f = fixture()
	const command = f.runner.command.bind(f.runner)
	f.runner.command = async (args) => {
		const result = await command(args)
		if (args[0] === 'login')
			f.viewer({ username: 'sam', email: 'sam@example.com', orgSlug: 'sam' })
		return result
	}
	await assert.rejects(f.execution.request('sign-in'), /account changed/)
	assert.equal(f.execution.authorized, null)
	assert.equal(f.state().ecid, null)
	assert.equal(
		f.calls.some((args) => args[0] === 'whoami'),
		false,
	)
})

test('Windows setup does not launch the unsupported runtime', async () => {
	const f = fixture()
	f.execution.platform = 'win32'
	assert.equal((await f.execution.request('state')).supported, false)
	await assert.rejects(
		f.execution.request('sign-in'),
		/not available on Windows/,
	)
	assert.deepEqual(f.calls, [])
})

test('host commands require native confirmation and verified ownership, and status combines local and server grants', async () => {
	const f = fixture({
		ecid: 'ec_test',
		enabled: false,
		owner: { username: 'jane', orgSlug: 'jane' },
	})
	let enabled = false
	f.runner.command = async (args) => {
		if (args[0] === 'daemon') return '{}'
		f.calls.push(args)
		if (args[2] === 'on') enabled = true
		if (args[2] === 'off') enabled = false
		return JSON.stringify({
			local: { enabled },
			contexts: [{ commands: { enabled } }],
		})
	}
	await f.execution.request('commands-on')
	assert.equal(enabled, false)
	assert.deepEqual(f.calls, [])
	f.execution.confirmCommands = async () => true
	assert.equal((await f.execution.request('commands-on')).commandsEnabled, true)
	assert.deepEqual(f.calls[0], [
		'context',
		'commands',
		'on',
		'--context',
		'ec_test',
		'--json',
	])
	assert.equal(
		(await f.execution.request('commands-off')).commandsEnabled,
		false,
	)
	f.viewer({ username: 'sam', email: 'sam@example.com', orgSlug: 'sam' })
	await assert.rejects(f.execution.request('commands-on'), /another workspace/)
})

test('an existing CLI registration and service are adopted, not duplicated', async () => {
	const f = fixture()
	f.machine({
		ecid: 'ec_old',
		contextName: 'old-laptop',
		contexts: [{ ecid: 'ec_old', name: 'old-laptop' }],
		installed: true,
		running: true,
		manager: 'launchd',
		runningVersion: '3.17.0',
		autoUpdate: { enabled: true },
	})
	const before = await f.execution.request('state')
	assert.deepEqual(before.existingContext, { id: 'ec_old', name: 'old-laptop' })
	assert.equal(before.autoUpdate, true)
	await f.execution.request('sign-in')
	const result = await f.execution.request('connect', 'old-laptop')
	assert.equal(
		f.calls.some((args) => args[1] === 'register'),
		false,
	)
	assert.equal(f.state().ecid, 'ec_old')
	assert.deepEqual(f.state().owner, { username: 'jane', orgSlug: 'jane' })
	assert.equal(f.runner.daemon, null)
	assert.equal(result.running, true)
	assert.equal(result.runner.mode, 'service')
	assert.match(result.runner.label, /launchd.*3\.17\.0/)
	await f.execution.request('stop')
	assert.deepEqual(f.calls.at(-1), [
		'daemon',
		'stop',
		'--context',
		'ec_old',
		'--json',
	])
	f.machine({ running: false })
	await f.execution.request('start')
	assert.deepEqual(f.calls.at(-1), [
		'daemon',
		'start',
		'--context',
		'ec_old',
		'--json',
	])
	f.machine({ running: true })
	await f.execution.request('restart')
	assert.deepEqual(f.calls.at(-1), ['daemon', 'restart', '--context', 'ec_old'])
	assert.equal(f.runner.daemon, null)
})
test('an existing CLI registration of another account is never adopted or duplicated', async () => {
	const f = fixture()
	f.machine({ contexts: [{ ecid: 'ec_theirs', name: 'shared-mac' }] })
	await f.execution.request('sign-in')
	await assert.rejects(
		f.execution.request('connect', 'mac'),
		/already registered as shared-mac/,
	)
	assert.equal(f.state().ecid, null)
	assert.equal(
		f.calls.some((args) => args[1] === 'register'),
		false,
	)
})
test('a daemon that already holds the runner lock keeps the app from starting a second one', async () => {
	const f = fixture({
		ecid: 'ec_test',
		enabled: true,
		owner: { username: 'jane', orgSlug: 'jane' },
	})
	f.machine({
		ecid: 'ec_test',
		runner: {
			pid: 4242,
			version: '3.17.0',
			launcher: 'terminal',
			startedAt: '2026-10-31T00:00:00.000Z',
		},
	})
	const result = await f.execution.request('state')
	assert.equal(f.runner.daemon, null)
	assert.equal(result.running, true)
	assert.equal(result.runner.mode, 'external')
	await assert.rejects(f.execution.request('restart'), /in a terminal/)
	f.machine({ runner: null })
	await f.execution.request('state')
	assert.ok(f.runner.daemon)
	assert.equal((await f.execution.request('state')).runner.mode, 'desktop')
})
test('the auto-update switch is the shared CLI policy', async () => {
	const f = fixture()
	f.machine({ autoUpdate: { enabled: true } })
	await f.execution.request('auto-update-off')
	assert.deepEqual(f.calls.at(-1), ['daemon', 'auto-update', 'off', '--json'])
	await f.execution.request('auto-update-on')
	assert.deepEqual(f.calls.at(-1), ['daemon', 'auto-update', 'on', '--json'])
})

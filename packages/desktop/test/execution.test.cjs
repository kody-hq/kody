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
	const runner = {
		daemon: null,
		async command(args) {
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

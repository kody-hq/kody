import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createChildTracker } from '../src/child-tracker.js'
import { resolveWrappingKey } from '../src/execution-context/keystore.js'
import {
	KeychainTimeoutError,
	type KeychainClock,
	createKeyringEntry,
	createMacSecurityAsyncEntry,
	createMacSecurityAsyncRunner,
	createMacSecurityEntry,
	keychainNoticeAfterMs,
	keychainTimeoutMs,
	parseMacSecurityPassword,
	macSecurityPath,
} from '../src/keyring-entry.js'

const notFound = { status: 44, stdout: '', stderr: 'item not found' }
const ok = { status: 0, stdout: '', stderr: '' }

test('macOS keychain entries go through /usr/bin/security with hex-encoded writes', () => {
	const calls: Array<Array<string>> = []
	let stored: string | null = null
	const entry = createMacSecurityEntry({
		service: 'kody.codes',
		account: 'cli:https://kody.codes',
		run: (args) => {
			calls.push(args)
			if (args[0] === 'add-generic-password') {
				stored = Buffer.from(args[args.indexOf('-X') + 1]!, 'hex').toString(
					'utf8',
				)
				return ok
			}
			if (args[0] === 'find-generic-password') {
				if (stored === null) return notFound
				return {
					...ok,
					stderr: `password: 0x${Buffer.from(stored).toString('hex').toUpperCase()}  "{"token":"\\303\\251"}"\n`,
				}
			}
			if (stored === null) return notFound
			stored = null
			return ok
		},
	})
	assert.equal(entry.getPassword(), null)
	entry.setPassword('{"token":"é"}')
	assert.deepEqual(calls[1]!.slice(0, 6), [
		'add-generic-password',
		'-U',
		'-s',
		'kody.codes',
		'-a',
		'cli:https://kody.codes',
	])
	assert.equal(calls[1]!.includes('{"token":"é"}'), false)
	assert.equal(entry.getPassword(), '{"token":"é"}')
	assert.equal(entry.deleteCredential(), true)
	assert.equal(entry.deleteCredential(), false)
})

test('macOS keychain errors other than item-not-found surface to the store', () => {
	const entry = createMacSecurityEntry({
		service: 'kody.codes',
		account: 'cli:https://kody.codes',
		run: () => ({ status: 51, stdout: '', stderr: 'user canceled' }),
	})
	assert.throws(() => entry.getPassword(), /exit 51/)
	assert.throws(() => entry.deleteCredential(), /exit 51/)
})

test('security -g output parses printable text and hex without ambiguity', () => {
	assert.equal(
		parseMacSecurityPassword('keychain: "x"\npassword: "abcd"\n'),
		'abcd',
	)
	assert.equal(
		parseMacSecurityPassword('password: "{"a":"b\\c"}"\n'),
		'{"a":"b\\c"}',
	)
	assert.equal(
		parseMacSecurityPassword(
			`password: 0x${Buffer.from('é').toString('hex').toUpperCase()}  "\\303\\251"\n`,
		),
		'é',
	)
	assert.equal(parseMacSecurityPassword('password: \n'), '')
	assert.equal(parseMacSecurityPassword('nothing'), null)
})

test('macOS keyring entries use the security CLI, not an in-process keychain call', () => {
	const mac = createKeyringEntry('cli:https://kody.codes', 'darwin')
	assert.equal(Object.getPrototypeOf(mac), Object.prototype)
	assert.deepEqual(Object.keys(mac).sort(), [
		'deleteCredential',
		'getPassword',
		'setPassword',
	])
})

class FakeSecurity extends EventEmitter {
	stdout = new EventEmitter()
	stderr = new EventEmitter()
	kills: Array<NodeJS.Signals | undefined> = []
	kill(signal?: NodeJS.Signals) {
		this.kills.push(signal)
		queueMicrotask(() => this.emit('close', null))
		return true
	}
}

function fakeClock() {
	const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = []
	const clock: KeychainClock = (run, ms) => {
		const timer = { run, ms, cancelled: false }
		timers.push(timer)
		return () => {
			timer.cancelled = true
		}
	}
	const fire = (ms: number) => {
		for (const timer of timers) {
			if (timer.ms === ms && !timer.cancelled) timer.run()
		}
	}
	const pending = () => timers.filter((timer) => !timer.cancelled)
	return { clock, fire, pending }
}

function fakeSignals() {
	const target = new EventEmitter()
	const raised: Array<NodeJS.Signals> = []
	return {
		target,
		raised,
		raise: (signal: NodeJS.Signals) => raised.push(signal),
	}
}

const ecAccount = 'execution-context:ec_test'

function asyncRunner(timeoutMs = 60_000) {
	const children: Array<FakeSecurity> = []
	const spawned: Array<Array<string>> = []
	const notices: Array<string> = []
	const time = fakeClock()
	const signals = fakeSignals()
	const tracker = createChildTracker(signals)
	const run = createMacSecurityAsyncRunner({
		service: 'kody.codes',
		account: ecAccount,
		timeoutMs,
		clock: time.clock,
		notice: (text) => notices.push(text),
		children: tracker,
		spawn: (command, args) => {
			spawned.push([command, ...args])
			const child = new FakeSecurity()
			children.push(child)
			return child
		},
	})
	return { run, children, spawned, notices, time, signals, tracker }
}

test('a fast Keychain call stays quiet and returns the security output', async () => {
	const { run, children, spawned, notices, time, tracker } = asyncRunner()
	const pending = run(['find-generic-password', '-s', 'kody.codes'])
	assert.deepEqual(spawned, [
		[macSecurityPath, 'find-generic-password', '-s', 'kody.codes'],
	])
	children[0]!.stderr.emit('data', Buffer.from('password: "abc"\n'))
	children[0]!.emit('close', 0)
	assert.deepEqual(await pending, {
		status: 0,
		stdout: '',
		stderr: 'password: "abc"\n',
	})
	time.fire(keychainNoticeAfterMs)
	assert.deepEqual(notices, [])
	assert.deepEqual(time.pending(), [])
	assert.equal(tracker.size, 0)
})

test('a slow Keychain call says it is waiting on a Keychain dialog', async () => {
	const { run, children, notices, time } = asyncRunner()
	const pending = run(['find-generic-password'])
	time.fire(keychainNoticeAfterMs)
	assert.deepEqual(notices, [
		'Waiting for macOS Keychain approval for kody.codes (execution-context:ec_test). Check for a Keychain dialog, possibly behind other windows.\n',
	])
	children[0]!.emit('close', 44)
	assert.equal((await pending).status, 44)
	assert.deepEqual(children[0]!.kills, [])
})

test('an unanswered Keychain dialog times out, kills security, and names the fixes', async () => {
	const { run, children, time, tracker } = asyncRunner(90_000)
	const pending = run(['find-generic-password'])
	time.fire(90_000)
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof KeychainTimeoutError)
		assert.match(error.message, /did not answer within 90s/)
		assert.match(error.message, /"Always Allow"/)
		assert.match(error.message, /kody daemon install --key-storage file/)
		assert.match(error.message, /KODY_KEYCHAIN_TIMEOUT_MS/)
		assert.doesNotMatch(error.message, /\u2014/)
		return true
	})
	assert.deepEqual(children[0]!.kills, ['SIGTERM'])
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(tracker.size, 0)
})

test('the --key-storage hint is only for execution context keys', () => {
	const login = new KeychainTimeoutError({
		service: 'kody.codes',
		account: 'cli:https://kody.codes',
		timeoutMs: 120_000,
	})
	assert.match(login.message, /within 120s/)
	assert.doesNotMatch(login.message, /--key-storage/)
})

test('KODY_KEYCHAIN_TIMEOUT_MS overrides the 2 minute Keychain timeout', () => {
	assert.equal(keychainTimeoutMs({}), 120_000)
	assert.equal(keychainTimeoutMs({ KODY_KEYCHAIN_TIMEOUT_MS: '5000' }), 5000)
	assert.equal(keychainTimeoutMs({ KODY_KEYCHAIN_TIMEOUT_MS: 'nope' }), 120_000)
	assert.equal(keychainTimeoutMs({ KODY_KEYCHAIN_TIMEOUT_MS: '0' }), 120_000)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	test(`${signal} during a pending Keychain prompt kills security, then exits as before`, () => {
		const { run, children, signals, tracker } = asyncRunner()
		void run(['find-generic-password']).catch(() => {})
		assert.equal(signals.target.listenerCount(signal), 1)
		signals.target.emit(signal, signal)
		assert.deepEqual(children[0]!.kills, ['SIGTERM'])
		assert.deepEqual(signals.raised, [signal])
		assert.equal(tracker.size, 0)
		assert.equal(signals.target.listenerCount(signal), 0)
	})
}

test('tracked children die on exit, and a signal someone else handles is not re-raised', () => {
	const signals = fakeSignals()
	const tracker = createChildTracker(signals)
	const first = tracker.track(new FakeSecurity())
	signals.target.emit('exit')
	assert.deepEqual(first.kills, ['SIGTERM'])
	assert.equal(signals.target.listenerCount('exit'), 0)

	const daemonDrain = () => {}
	signals.target.on('SIGTERM', daemonDrain)
	const second = tracker.track(new FakeSecurity())
	signals.target.emit('SIGTERM', 'SIGTERM')
	assert.deepEqual(second.kills, ['SIGTERM'])
	assert.deepEqual(signals.raised, [])
	assert.deepEqual(signals.target.listeners('SIGTERM'), [daemonDrain])

	const third = tracker.track(new FakeSecurity())
	third.emit('close', 0)
	assert.equal(tracker.size, 0)
	assert.equal(signals.target.listenerCount('SIGINT'), 0)
})

test('the async macOS entry reads, writes, and maps item-not-found', async () => {
	const calls: Array<Array<string>> = []
	let stored: string | null = null
	const entry = createMacSecurityAsyncEntry({
		service: 'kody.codes',
		account: ecAccount,
		run: async (args) => {
			calls.push(args)
			if (args[0] === 'add-generic-password') {
				stored = Buffer.from(args[args.indexOf('-X') + 1]!, 'hex').toString(
					'utf8',
				)
				return ok
			}
			return stored === null
				? notFound
				: { ...ok, stderr: `password: "${stored}"\n` }
		},
	})
	assert.equal(await entry.getPassword(), null)
	await entry.setPassword('wrapping-key')
	assert.equal(await entry.getPassword(), 'wrapping-key')
	assert.deepEqual(calls[0], [
		'find-generic-password',
		'-s',
		'kody.codes',
		'-a',
		ecAccount,
		'-g',
	])
})

test('a Keychain timeout reaches the daemon instead of looking like a missing key', async () => {
	const timeout = new KeychainTimeoutError({
		service: 'kody.codes',
		account: ecAccount,
		timeoutMs: 1000,
	})
	const source = resolveWrappingKey({
		ecid: 'ec_test',
		create: false,
		env: {},
		keyringFactory: () => ({
			getPassword: async () => {
				throw timeout
			},
			setPassword: async () => {},
		}),
	})
	await assert.rejects(source.key(null), (error) => error === timeout)
})

test(
	'a real macOS keychain round-trips JSON and UTF-8 through /usr/bin/security',
	{ skip: process.platform !== 'darwin' },
	async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kody-keychain-'))
		const keychain = join(dir, 'kody-test.keychain-db')
		execFileSync(macSecurityPath, ['create-keychain', '-p', 'kody', keychain])
		try {
			execFileSync(macSecurityPath, ['unlock-keychain', '-p', 'kody', keychain])
			const entry = createMacSecurityEntry({
				service: 'kody.codes.test',
				account: `cli:${dir}`,
				keychain,
			})
			assert.equal(entry.getPassword(), null)
			const json = JSON.stringify({
				version: 1,
				accessToken: 'a'.repeat(3000),
				note: 'naïve ✓',
			})
			entry.setPassword(json)
			assert.equal(entry.getPassword(), json)
			for (const value of ['abcd', '{"a":"b\\\\c"}', 'plain-ascii']) {
				entry.setPassword(value)
				assert.equal(entry.getPassword(), value)
			}
			const asyncEntry = createMacSecurityAsyncEntry({
				service: 'kody.codes.test',
				account: `cli:${dir}`,
				keychain,
			})
			assert.equal(await asyncEntry.getPassword(), 'plain-ascii')
			await asyncEntry.setPassword(json)
			assert.equal(entry.getPassword(), json)
			assert.equal(entry.deleteCredential(), true)
			assert.equal(entry.getPassword(), null)
			assert.equal(await asyncEntry.getPassword(), null)
			assert.equal(entry.deleteCredential(), false)
		} finally {
			execFileSync(macSecurityPath, ['delete-keychain', keychain])
			rmSync(dir, { recursive: true, force: true })
		}
	},
)

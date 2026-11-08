import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	createKeyringEntry,
	createMacSecurityEntry,
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

test(
	'a real macOS keychain round-trips JSON and UTF-8 through /usr/bin/security',
	{ skip: process.platform !== 'darwin' },
	() => {
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
			assert.equal(entry.deleteCredential(), true)
			assert.equal(entry.getPassword(), null)
			assert.equal(entry.deleteCredential(), false)
		} finally {
			execFileSync(macSecurityPath, ['delete-keychain', keychain])
			rmSync(dir, { recursive: true, force: true })
		}
	},
)

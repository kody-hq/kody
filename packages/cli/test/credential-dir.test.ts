import { EventEmitter } from 'node:events'
import { type spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	CredentialDirError,
	credentialDirFor,
	ensureCredentialDirWritable,
	isCredentialFolderError,
} from '../src/credential-dir.js'
import {
	formatLoginUrlNotice,
	loginBrowserOpenFailedNotice,
} from '../src/login-notice.js'
import { openUrl } from '../src/open-url.js'

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), 'kody-cli-credential-dir-'))
}

function fakeSpawn(behavior: (child: EventEmitter) => void) {
	return (() => {
		const child = Object.assign(new EventEmitter(), { unref() {} })
		queueMicrotask(() => behavior(child))
		return child
	}) as unknown as typeof spawn
}

test('ensureCredentialDirWritable creates a missing folder and leaves no probe file', () => {
	const dir = join(tempRoot(), 'Library', 'Application Support', 'kody')
	assert.equal(existsSync(dir), false)
	ensureCredentialDirWritable(dir)
	assert.equal(statSync(dir).isDirectory(), true)
	assert.deepEqual(readdirSync(dir), [])
})

test('ensureCredentialDirWritable names the folder and the fix when it cannot be created', () => {
	const root = tempRoot()
	const blocker = join(root, 'Application Support')
	writeFileSync(blocker, 'not a folder')
	const dir = join(blocker, 'kody')
	assert.throws(
		() => ensureCredentialDirWritable(dir, { platform: 'darwin' }),
		(error: unknown) => {
			assert.ok(error instanceof CredentialDirError)
			assert.equal(error.dir, dir)
			assert.match(error.message, /not allowed to save files in this folder/)
			assert.ok(error.message.includes(dir))
			assert.match(error.message, /What went wrong: /)
			assert.match(error.message, /chown -R "\$\(whoami\)"/)
			assert.match(error.message, /Full Disk Access/)
			assert.match(error.message, /kody login/)
			return true
		},
	)
})

test(
	'ensureCredentialDirWritable fails when the folder exists but is read-only',
	{ skip: process.platform === 'win32' || process.getuid?.() === 0 },
	() => {
		const dir = join(tempRoot(), 'kody')
		mkdirSync(dir)
		chmodSync(dir, 0o500)
		try {
			assert.throws(
				() => ensureCredentialDirWritable(dir),
				(error: unknown) =>
					error instanceof CredentialDirError &&
					error.code === 'EACCES' &&
					error.message.includes(dir),
			)
		} finally {
			chmodSync(dir, 0o700)
		}
	},
)

test('credentialDirFor follows the file store path override', () => {
	assert.equal(
		credentialDirFor('https://kody.codes/mcp', {
			fileStorePath: () => '/tmp/kody-test/credentials.json',
		}),
		'/tmp/kody-test',
	)
})

test('isCredentialFolderError only matches folder and permission codes', () => {
	const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
	assert.equal(isCredentialFolderError(eacces), true)
	assert.equal(isCredentialFolderError(new Error('keychain locked')), false)
})

test('login notice always prints the sign-in URL, with or without the browser', () => {
	const url = new URL('https://kody.codes/oauth/authorize?state=abc')
	const opening = formatLoginUrlNotice({ url, openBrowser: true })
	assert.ok(opening.includes(url.href))
	assert.match(opening, /If no browser window appears, copy this link/)
	assert.match(opening, /Waiting for you to finish signing in/)
	assert.match(opening, /New to Kody\? Create an account on that page/)
	const manual = formatLoginUrlNotice({ url, openBrowser: false })
	assert.ok(manual.includes(url.href))
	assert.match(manual, /Open this link in your browser/)
	assert.match(manual, /New to Kody\? Create an account on that page/)
	assert.match(loginBrowserOpenFailedNotice, /could not open your browser/)
})

test('openUrl reports false when the system opener fails', async () => {
	assert.equal(
		await openUrl('https://kody.codes', {
			platform: 'darwin',
			spawnFn: fakeSpawn((child) => child.emit('exit', 1)),
		}),
		false,
	)
	assert.equal(
		await openUrl('https://kody.codes', {
			platform: 'linux',
			spawnFn: fakeSpawn((child) => child.emit('error', new Error('ENOENT'))),
		}),
		false,
	)
})

test('openUrl reports true on a clean exit or a still-running opener', async () => {
	assert.equal(
		await openUrl('https://kody.codes', {
			platform: 'darwin',
			spawnFn: fakeSpawn((child) => child.emit('exit', 0)),
		}),
		true,
	)
	assert.equal(
		await openUrl('https://kody.codes', {
			platform: 'linux',
			settleMs: 20,
			spawnFn: fakeSpawn(() => {}),
		}),
		true,
	)
})

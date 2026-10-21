import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
	cachedWorkerdPath,
	downloadVerifiedGzip,
	ensureWorkerdBinary,
	userCacheDir,
	workerdAssetUrl,
	workerdTargetFor,
} from '../src/workerd-binary.js'

function serve(body: Buffer) {
	const urls: Array<string> = []
	const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
		urls.push(String(input))
		return new Response(new Uint8Array(body))
	}) as typeof fetch
	return { fetchFn, urls }
}

test('workerdTargetFor covers Linux and macOS on x64/arm64 only', () => {
	assert.equal(workerdTargetFor('linux', 'x64'), 'linux-64')
	assert.equal(workerdTargetFor('linux', 'arm64'), 'linux-arm64')
	assert.equal(workerdTargetFor('darwin', 'x64'), 'darwin-64')
	assert.equal(workerdTargetFor('darwin', 'arm64'), 'darwin-arm64')
	assert.throws(
		() => workerdTargetFor('win32', 'x64'),
		/supports Linux and macOS/,
	)
	assert.throws(
		() => workerdTargetFor('linux', 'ia32'),
		/supports Linux and macOS/,
	)
})

test('userCacheDir honors KODY_CACHE_DIR, XDG_CACHE_HOME, and macOS Caches', () => {
	assert.equal(
		userCacheDir({ KODY_CACHE_DIR: '/x/kody' }, 'linux', '/home/u'),
		'/x/kody',
	)
	assert.equal(
		userCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u'),
		'/xdg/kody',
	)
	assert.equal(userCacheDir({}, 'linux', '/home/u'), '/home/u/.cache/kody')
	assert.equal(
		userCacheDir({}, 'darwin', '/Users/u'),
		'/Users/u/Library/Caches/kody',
	)
})

test('ensureWorkerdBinary prefers KODY_WORKERD_PATH without downloading', async () => {
	const { fetchFn, urls } = serve(Buffer.from('unused'))
	const path = await ensureWorkerdBinary({
		env: { KODY_WORKERD_PATH: '/opt/workerd' },
		fetchFn,
	})
	assert.equal(path, '/opt/workerd')
	assert.equal(urls.length, 0)
})

test('ensureWorkerdBinary refuses a download whose digest does not match the pin', async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), 'kody-workerd-'))
	const { fetchFn, urls } = serve(
		gzipSync(Buffer.from('#!/bin/sh\necho tampered\n')),
	)
	await assert.rejects(
		() =>
			ensureWorkerdBinary({ env: {}, cacheDir, target: 'linux-64', fetchFn }),
		/failed verification/,
	)
	assert.deepEqual(urls, [workerdAssetUrl('linux-64')])
	const binaryPath = cachedWorkerdPath(cacheDir, 'linux-64')
	assert.equal(existsSync(binaryPath), false)
	assert.deepEqual(readdirSync(dirname(binaryPath)), [])
})

test('downloadVerifiedGzip writes an executable binary when the digest matches', async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), 'kody-workerd-'))
	const binary = Buffer.from('#!/bin/sh\necho workerd\n')
	const gz = gzipSync(binary)
	const destination = join(cacheDir, 'nested', 'workerd')
	await downloadVerifiedGzip({
		url: 'https://example.test/workerd.gz',
		sha256: createHash('sha256').update(gz).digest('hex'),
		destination,
		fetchFn: serve(gz).fetchFn,
	})
	assert.deepEqual(readFileSync(destination), binary)
	assert.equal(statSync(destination).mode & 0o111, 0o111)
	assert.deepEqual(readdirSync(dirname(destination)), ['workerd'])
})

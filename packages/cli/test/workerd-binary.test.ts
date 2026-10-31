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
	WorkerdDownloadStalledError,
	workerdAssetUrl,
	workerdTargetFor,
	workerdVersion,
} from '../src/workerd-binary.js'

function serve(body: Buffer) {
	const urls: Array<string> = []
	const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
		urls.push(String(input))
		return new Response(new Uint8Array(body))
	}) as typeof fetch
	return { fetchFn, urls }
}

test('workerdTargetFor covers Linux, macOS, and Windows on x64/arm64', () => {
	assert.equal(workerdTargetFor('linux', 'x64'), 'linux-64')
	assert.equal(workerdTargetFor('linux', 'arm64'), 'linux-arm64')
	assert.equal(workerdTargetFor('darwin', 'x64'), 'darwin-64')
	assert.equal(workerdTargetFor('darwin', 'arm64'), 'darwin-arm64')
	assert.equal(workerdTargetFor('win32', 'x64'), 'windows-64')
	assert.equal(workerdTargetFor('win32', 'arm64'), 'windows-64')
	assert.throws(
		() => workerdTargetFor('linux', 'ia32'),
		/supports Linux, macOS, and Windows/,
	)
	assert.throws(
		() => workerdTargetFor('freebsd', 'x64'),
		/supports Linux, macOS, and Windows/,
	)
})

test('cachedWorkerdPath names the Windows binary workerd.exe', () => {
	assert.equal(
		cachedWorkerdPath('cache', 'windows-64'),
		join('cache', 'workerd', `${workerdVersion}-windows-64`, 'workerd.exe'),
	)
	assert.equal(
		cachedWorkerdPath('cache', 'linux-64'),
		join('cache', 'workerd', `${workerdVersion}-linux-64`, 'workerd'),
	)
})

test('userCacheDir honors KODY_CACHE_DIR, XDG_CACHE_HOME, and macOS Caches', () => {
	assert.equal(
		userCacheDir({ KODY_CACHE_DIR: '/x/kody' }, 'linux', '/home/u'),
		'/x/kody',
	)
	assert.equal(
		userCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u'),
		join('/xdg', 'kody'),
	)
	assert.equal(
		userCacheDir({}, 'linux', '/home/u'),
		join('/home/u', '.cache', 'kody'),
	)
	assert.equal(
		userCacheDir({}, 'darwin', '/Users/u'),
		join('/Users/u', 'Library', 'Caches', 'kody'),
	)
	assert.equal(
		userCacheDir(
			{ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
			'win32',
			'C:\\Users\\u',
		),
		join('C:\\Users\\u\\AppData\\Local', 'kody', 'cache'),
	)
	assert.equal(
		userCacheDir({}, 'win32', 'C:\\Users\\u'),
		join('C:\\Users\\u', 'AppData', 'Local', 'kody', 'cache'),
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
	if (process.platform !== 'win32') {
		assert.equal(statSync(destination).mode & 0o111, 0o111)
	}
	assert.deepEqual(readdirSync(dirname(destination)), ['workerd'])
})

/** Sends `head` then stalls until the request is aborted; later calls get `body`. */
function serveStallingThen(head: Buffer, body: Buffer | null) {
	let calls = 0
	const fetchFn = (async (
		_input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		calls += 1
		if (calls > 1 && body) return new Response(new Uint8Array(body))
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(head))
				init?.signal?.addEventListener('abort', () =>
					controller.error(init.signal?.reason),
				)
			},
		})
		return new Response(stream)
	}) as typeof fetch
	return { fetchFn, calls: () => calls }
}

/** Streams `body` in `parts` chunks, `gapMs` apart. */
function serveProgressing(body: Buffer, gapMs: number, parts: number) {
	const size = Math.ceil(body.length / parts)
	const fetchFn = (async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					for (let offset = 0; offset < body.length; offset += size) {
						await new Promise((resolve) => setTimeout(resolve, gapMs))
						controller.enqueue(
							new Uint8Array(body.subarray(offset, offset + size)),
						)
					}
					controller.close()
				},
			}),
		)) as typeof fetch
	return { fetchFn }
}

test('downloadVerifiedGzip keeps going past the idle timeout while bytes keep arriving', async () => {
	const binary = Buffer.from('#!/bin/sh\necho slow but steady\n')
	const gz = gzipSync(binary)
	const destination = join(mkdtempSync(join(tmpdir(), 'kody-wd-')), 'workerd')
	const { fetchFn } = serveProgressing(gz, 60, 6)
	await downloadVerifiedGzip({
		url: 'https://example.com/workerd.gz',
		sha256: createHash('sha256').update(gz).digest('hex'),
		destination,
		fetchFn,
		idleTimeoutMs: 200,
	})
	assert.equal(readFileSync(destination, 'utf8'), binary.toString())
})

test('downloadVerifiedGzip aborts with a stall error when bytes stop arriving', async () => {
	const destination = join(mkdtempSync(join(tmpdir(), 'kody-wd-')), 'workerd')
	const server = serveStallingThen(Buffer.from('partial'), null)
	await assert.rejects(
		downloadVerifiedGzip({
			url: 'https://example.com/workerd.gz',
			sha256: 'unused',
			destination,
			fetchFn: server.fetchFn,
			idleTimeoutMs: 50,
		}),
		(error: unknown) =>
			error instanceof WorkerdDownloadStalledError &&
			/no bytes arrived from https:\/\/example\.com\/workerd\.gz/.test(
				error.message,
			),
	)
	assert.deepEqual(readdirSync(dirname(destination)), [])
})

test('ensureWorkerdBinary retries a stalled download once', async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), 'kody-wd-'))
	const server = serveStallingThen(
		Buffer.from('x'),
		gzipSync(Buffer.from('#!/bin/sh\necho retried\n')),
	)
	const downloads: Array<string> = []
	await assert.rejects(
		ensureWorkerdBinary({
			env: {},
			cacheDir,
			target: 'linux-64',
			fetchFn: server.fetchFn,
			idleTimeoutMs: 50,
			onDownload: (url) => downloads.push(url),
		}),
		/failed verification/,
	)
	assert.equal(server.calls(), 2)
	assert.equal(downloads.length, 2)
})

test('ensureWorkerdBinary names the download step when both attempts stall', async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), 'kody-wd-'))
	const server = serveStallingThen(Buffer.from('x'), null)
	await assert.rejects(
		ensureWorkerdBinary({
			env: {},
			cacheDir,
			target: 'linux-64',
			fetchFn: server.fetchFn,
			idleTimeoutMs: 50,
		}),
		/Downloading workerd for local execute stalled twice: no bytes arrived/,
	)
	assert.equal(server.calls(), 2)
})

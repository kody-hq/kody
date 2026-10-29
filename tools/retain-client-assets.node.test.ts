import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { retainClientAssets } from './retain-client-assets.ts'

const directories: Array<string> = []
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('an old document can load its lazy chunk and dependency after two deploys', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	const build = (name: string, files: Record<string, string>) => {
		const directory = path.join(root, name)
		mkdirSync(path.join(directory, 'assets'), { recursive: true })
		for (const [file, content] of Object.entries(files)) {
			writeFileSync(path.join(directory, 'assets', file), content)
		}
		return directory
	}
	const first = build('first', {
		'lazy-abcdefgh.js': 'import "./shared-12345678.js"',
		'shared-12345678.js': 'export const value = 1',
		'index.html': 'never retain HTML',
		'private-abcdefgh.js.map': 'never retain source maps',
	})
	const archive = path.join(root, 'archive')
	const nextArchive = path.join(root, 'next-archive')
	const now = 10 * 24 * 60 * 60 * 1_000
	retainClientAssets({
		clientDirectory: first,
		previousDirectory: path.join(root, 'none'),
		archiveDirectory: archive,
		now,
	})
	const second = build('second', { 'lazy-ijklmnop.js': 'export default 2' })
	retainClientAssets({
		clientDirectory: second,
		previousDirectory: archive,
		archiveDirectory: nextArchive,
		now: now + 1_000,
	})
	expect(
		readFileSync(path.join(second, 'assets/lazy-abcdefgh.js'), 'utf8'),
	).toContain('shared-12345678.js')
	expect(
		readFileSync(path.join(second, 'assets/shared-12345678.js'), 'utf8'),
	).toContain('value = 1')
	const manifest = JSON.parse(
		readFileSync(path.join(nextArchive, 'manifest.json'), 'utf8'),
	)
	expect(Object.keys(manifest)).toHaveLength(3)
	expect(manifest['lazy-abcdefgh.js']).toBe(now)
	const third = build('third', { 'lazy-qrstuvwx.js': 'export default 3' })
	retainClientAssets({
		clientDirectory: third,
		previousDirectory: nextArchive,
		archiveDirectory: path.join(root, 'third-archive'),
		now: now + 8 * 24 * 60 * 60 * 1_000,
	})
	expect(
		JSON.parse(
			readFileSync(path.join(root, 'third-archive/manifest.json'), 'utf8'),
		),
	).toEqual({ 'lazy-qrstuvwx.js': now + 8 * 24 * 60 * 60 * 1_000 })
})

test('rejects manifest paths outside the hashed public asset directory', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	mkdirSync(path.join(root, 'client/assets'), { recursive: true })
	mkdirSync(path.join(root, 'previous'), { recursive: true })
	writeFileSync(
		path.join(root, 'previous/manifest.json'),
		JSON.stringify({ '../secret-abcdefgh.js': 1 }),
	)
	expect(() =>
		retainClientAssets({
			clientDirectory: path.join(root, 'client'),
			previousDirectory: path.join(root, 'previous'),
			archiveDirectory: path.join(root, 'archive'),
			now: 2,
		}),
	).toThrow('Invalid retained client asset entry')
})

test('fails instead of serving changed bytes under an existing immutable URL', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	for (const directory of ['client', 'previous']) {
		mkdirSync(path.join(root, directory, 'assets'), { recursive: true })
	}
	writeFileSync(
		path.join(root, 'previous/manifest.json'),
		JSON.stringify({ 'chunk-abcdefgh.js': 1 }),
	)
	writeFileSync(
		path.join(root, 'previous/assets/chunk-abcdefgh.js'),
		'old bytes',
	)
	writeFileSync(
		path.join(root, 'client/assets/chunk-abcdefgh.js'),
		'different bytes',
	)
	expect(() =>
		retainClientAssets({
			clientDirectory: path.join(root, 'client'),
			previousDirectory: path.join(root, 'previous'),
			archiveDirectory: path.join(root, 'archive'),
			now: 2,
		}),
	).toThrow('Immutable client asset changed')
})

test('drops the oldest retained assets when deploys outgrow the asset budget', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	const day = 24 * 60 * 60 * 1_000
	const now = 10 * day
	const previous = path.join(root, 'previous')
	mkdirSync(path.join(previous, 'assets'), { recursive: true })
	const manifest: Record<string, number> = {
		'oldest-aaaaaaaa.js': now - 3 * day,
		'older-bbbbbbbb.js': now - 2 * day,
		'newer-cccccccc.js': now - day,
	}
	for (const name of Object.keys(manifest)) {
		writeFileSync(path.join(previous, 'assets', name), name)
	}
	writeFileSync(path.join(previous, 'manifest.json'), JSON.stringify(manifest))
	const client = path.join(root, 'client')
	mkdirSync(path.join(client, 'assets'), { recursive: true })
	writeFileSync(path.join(client, 'assets', 'fresh-dddddddd.js'), 'fresh')
	writeFileSync(path.join(client, 'assets', 'fresh-eeeeeeee.css'), 'fresh')
	const archive = path.join(root, 'archive')
	retainClientAssets({
		clientDirectory: client,
		previousDirectory: previous,
		archiveDirectory: archive,
		now,
		maxAssets: 3,
	})
	expect(
		Object.keys(
			JSON.parse(readFileSync(path.join(archive, 'manifest.json'), 'utf8')),
		).sort(),
	).toEqual(['fresh-dddddddd.js', 'fresh-eeeeeeee.css', 'newer-cccccccc.js'])
	expect(
		readFileSync(path.join(client, 'assets/newer-cccccccc.js'), 'utf8'),
	).toBe('newer-cccccccc.js')
	expect(() =>
		readFileSync(path.join(client, 'assets/oldest-aaaaaaaa.js')),
	).toThrow(/ENOENT/)
	expect(() =>
		retainClientAssets({
			clientDirectory: client,
			previousDirectory: archive,
			archiveDirectory: path.join(root, 'too-big'),
			now,
			maxAssets: 1,
		}),
	).toThrow('Retained assets approach the Workers static asset limit')
})

test('evicts a whole retained build instead of splitting a chunk from its dependency', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	const day = 24 * 60 * 60 * 1_000
	const now = 10 * day
	const previous = path.join(root, 'previous')
	mkdirSync(path.join(previous, 'assets'), { recursive: true })
	const manifest: Record<string, number> = {
		'lazy-aaaaaaaa.js': now - day,
		'shared-bbbbbbbb.js': now - day,
	}
	for (const name of Object.keys(manifest)) {
		writeFileSync(path.join(previous, 'assets', name), name)
	}
	writeFileSync(path.join(previous, 'manifest.json'), JSON.stringify(manifest))
	const client = path.join(root, 'client')
	mkdirSync(path.join(client, 'assets'), { recursive: true })
	writeFileSync(path.join(client, 'assets', 'fresh-cccccccc.js'), 'fresh')
	const archive = path.join(root, 'archive')
	retainClientAssets({
		clientDirectory: client,
		previousDirectory: previous,
		archiveDirectory: archive,
		now,
		maxAssets: 2,
	})
	expect(
		Object.keys(
			JSON.parse(readFileSync(path.join(archive, 'manifest.json'), 'utf8')),
		),
	).toEqual(['fresh-cccccccc.js'])
})

test('never drops a retained build inside the minimum retention window', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'retained-assets-'))
	directories.push(root)
	const hour = 60 * 60 * 1_000
	const now = 240 * hour
	const previous = path.join(root, 'previous')
	mkdirSync(path.join(previous, 'assets'), { recursive: true })
	const manifest: Record<string, number> = {
		'recent-aaaaaaaa.js': now - 23 * hour,
		'stale-bbbbbbbb.js': now - 25 * hour,
	}
	for (const name of Object.keys(manifest)) {
		writeFileSync(path.join(previous, 'assets', name), name)
	}
	writeFileSync(path.join(previous, 'manifest.json'), JSON.stringify(manifest))
	const client = path.join(root, 'client')
	mkdirSync(path.join(client, 'assets'), { recursive: true })
	writeFileSync(path.join(client, 'assets', 'fresh-cccccccc.js'), 'fresh')
	const archive = path.join(root, 'archive')
	retainClientAssets({
		clientDirectory: client,
		previousDirectory: previous,
		archiveDirectory: archive,
		now,
		maxAssets: 2,
	})
	expect(
		Object.keys(
			JSON.parse(readFileSync(path.join(archive, 'manifest.json'), 'utf8')),
		).sort(),
	).toEqual(['fresh-cccccccc.js', 'recent-aaaaaaaa.js'])
	const tight = path.join(root, 'tight-client')
	mkdirSync(path.join(tight, 'assets'), { recursive: true })
	writeFileSync(path.join(tight, 'assets', 'fresh-dddddddd.js'), 'fresh')
	expect(() =>
		retainClientAssets({
			clientDirectory: tight,
			previousDirectory: previous,
			archiveDirectory: path.join(root, 'tight-archive'),
			now,
			maxAssets: 1,
		}),
	).toThrow('within the minimum retention window')
	expect(existsSync(path.join(root, 'tight-archive'))).toBe(false)
})

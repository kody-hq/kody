import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import chokidar, { type FSWatcher } from 'chokidar'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDevWatcher } from '../src/dev/dev-watcher.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('track detaches the poll map so a concurrent poll cannot echo a rebuild', async (t) => {
	// This contract is about stat polling. Native watch events may arrive after
	// track finishes, so drive watcher readiness separately from that channel.
	const nativeWatcher = Object.assign(new EventEmitter(), {
		close: async () => {},
	})
	t.mock.method(chokidar, 'watch', () => {
		queueMicrotask(() => nativeWatcher.emit('ready'))
		return nativeWatcher as FSWatcher
	})
	const root = await mkdtemp(join(tmpdir(), 'kody-watcher-'))
	const changes: Array<string> = []
	try {
		const file = join(root, 'app.ts')
		await writeFile(file, 'export const n = 1\n')
		const watcher = createDevWatcher({
			root,
			onChange: (path) => {
				changes.push(path)
			},
			pollIntervalMs: 15,
		})
		await watcher.ready
		await watcher.track([file])

		// Edit, then start track. track() detaches `tracked` synchronously so
		// any in-flight poll must abandon; clear chokidar noise after that.
		await writeFile(file, 'export const n = 2\n')
		await sleep(40)
		const tracking = watcher.track([file], { ignoreChanges: [file] })
		changes.length = 0
		await sleep(50)
		await tracking
		await sleep(50)
		assert.deepEqual(
			changes,
			[],
			'poll must not echo the file track just baselined',
		)
		await watcher.close()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('track reports mid-build edits that are not in ignoreChanges', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-watcher-mid-'))
	try {
		await mkdir(join(root, 'app'), { recursive: true })
		const entry = join(root, 'app/entry.ts')
		const other = join(root, 'app/other.ts')
		await writeFile(entry, 'export const a = 1\n')
		await writeFile(other, 'export const b = 1\n')
		const watcher = createDevWatcher({
			root,
			onChange: () => {},
			pollIntervalMs: 60_000,
		})
		await watcher.ready
		await watcher.track([entry, other])
		// Change length so size:mtime fingerprints differ even on coarse FS clocks.
		await writeFile(other, 'export const b = 22\n')
		const changed = await watcher.track([entry, other], {
			ignoreChanges: [entry],
		})
		assert.deepEqual([...changed], [other])
		await watcher.close()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

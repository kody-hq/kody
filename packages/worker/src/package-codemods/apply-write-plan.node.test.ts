import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	bytesToSnapshotString,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'
import {
	CodemodApplyWritePlanError,
	isBinarySnapshotFile,
	planCodemodApplyWrites,
} from './apply-write-plan.ts'

function fixture(name: string) {
	return new Uint8Array(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
	)
}

function loadedTree() {
	return {
		'package.json': '{"name":"@kent/notes"}',
		'README.md': 'See https://kent.kody.run/notes/ for the app.\n',
		'public/icon.png': bytesToSnapshotString(
			fixture('icon.png'),
			'public/icon.png',
		),
		'public/fonts/font.woff2': bytesToSnapshotString(
			fixture('font.woff2'),
			'public/fonts/font.woff2',
		),
	}
}

test('a loaded PNG or woff2 is a byte string that a UTF-8 write would corrupt', () => {
	const tree = loadedTree()
	for (const [path, name] of [
		['public/icon.png', 'icon.png'],
		['public/fonts/font.woff2', 'font.woff2'],
	] as const) {
		const bytes = fixture(name)
		expect(isBinarySnapshotFile(path, tree[path])).toBe(true)
		expect(snapshotStringToBytes(tree[path], path)).toEqual(bytes)
		// What a repo session write edit does with the same string.
		const utf8 = new TextEncoder().encode(tree[path])
		expect(utf8.byteLength).toBeGreaterThan(bytes.byteLength)
	}
	const png = new TextEncoder().encode(tree['public/icon.png'])
	expect([...png.subarray(0, 5)]).toEqual([0xc2, 0x89, 0x50, 0x4e, 0x47])
})

test('apply writes only the files the codemod changed and leaves binary files alone', () => {
	const before = loadedTree()
	const after = {
		...before,
		'README.md': 'See https://notes--kent.kody.run/ for the app.\n',
	}
	expect(
		planCodemodApplyWrites({
			before,
			after,
			expectedChangedPaths: ['README.md'],
		}),
	).toEqual(['README.md'])
	expect(planCodemodApplyWrites({ before, after: { ...before } })).toEqual([])
})

test('apply fails closed on a changed file that is not UTF-8 text', () => {
	const before = loadedTree()
	for (const path of ['public/icon.png', 'public/fonts/font.woff2'] as const) {
		expect(() =>
			planCodemodApplyWrites({
				before,
				after: { ...before, [path]: `${before[path]}x` },
			}),
		).toThrow(CodemodApplyWritePlanError)
	}
	expect(() =>
		planCodemodApplyWrites({
			before: { ...before, 'data.bin': 'a\0b' },
			after: { ...before, 'data.bin': 'a\0c' },
		}),
	).toThrow(/not UTF-8 text \(data\.bin\)/)
	const lossy = new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62]))
	expect(() =>
		planCodemodApplyWrites({
			before: { ...before, 'notes.dat': lossy },
			after: { ...before, 'notes.dat': `${lossy} https://new` },
		}),
	).toThrow(/not UTF-8 text \(notes\.dat\)/)
})

test('apply fails closed on removed files and on writes the codemod did not report', () => {
	const before = loadedTree()
	const { 'README.md': _readme, ...withoutReadme } = before
	expect(() =>
		planCodemodApplyWrites({ before, after: withoutReadme }),
	).toThrow(/cannot remove files \(README\.md\)/)
	expect(() =>
		planCodemodApplyWrites({
			before,
			after: { ...before, 'README.md': 'new', 'package.json': '{}' },
			expectedChangedPaths: ['README.md'],
		}),
	).toThrow(
		/do not match what the codemod reported as changed \(package\.json\)/,
	)
	expect(() =>
		planCodemodApplyWrites({
			before,
			after: { ...before },
			expectedChangedPaths: ['README.md'],
		}),
	).toThrow(/do not match what the codemod reported as changed \(README\.md\)/)
})

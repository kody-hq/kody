import { execFileSync } from 'node:child_process'
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('attribution uses generated UTF-8 spans, not original source lengths', () => {
	const root = mkdtempSync(join(tmpdir(), 'kody-perf-attribution-'))
	try {
		mkdirSync(join(root, 'dist/client'), { recursive: true })
		writeFileSync(join(root, 'dist/client/test.js'), 'abéx\n')
		writeFileSync(
			join(root, 'dist/client/test.js.map'),
			JSON.stringify({
				version: 3,
				sources: ['packages/a.ts', 'node_modules/dep/index.js'],
				names: [],
				mappings: 'AAAA,ECAA',
				sourcesContent: ['a'.repeat(100), 'b'.repeat(500)],
			}),
		)
		writeFileSync(
			join(root, 'targets.json'),
			JSON.stringify([{ label: 'fixture', root }]),
		)
		execFileSync(process.execPath, [
			new URL('attribute.mjs', import.meta.url).pathname,
			join(root, 'targets.json'),
			join(root, 'result.json'),
		])
		const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
			.results[0]
		expect(result.sources).toEqual([
			{ source: 'dep', bytes: 3 },
			{ source: 'packages/a.ts', bytes: 2 },
		])
		expect(result.assets[0]).toMatchObject({ bytes: 6, mappedBytes: 5 })
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { guardHarfbuzzEnvironmentProbe } from './vite-harfbuzz-worker.ts'

test('the installed harfbuzzjs/hb.js still has the environment probe the Worker build guards', () => {
	const hbJsPath = createRequire(import.meta.url).resolve('harfbuzzjs/hb.js')
	const guarded = guardHarfbuzzEnvironmentProbe(readFileSync(hbJsPath, 'utf8'))
	expect(guarded).toContain('_scriptName=self.location?.href')
	expect(guarded).not.toContain('scriptDirectory=__dirname+"/"')
})

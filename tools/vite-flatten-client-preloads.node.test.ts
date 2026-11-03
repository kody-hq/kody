import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { expect, test } from 'vitest'
import {
	flattenClientPreloads,
	withFlattenedImports,
} from './vite-flatten-client-preloads.ts'

test('chunks report their whole static closure so every chunk is preloaded', () => {
	const bundle = {
		'entry.js': { type: 'chunk' as const, imports: ['a.js', 'b.js'] },
		'a.js': { type: 'chunk' as const, imports: ['schemas.js'] },
		'b.js': { type: 'chunk' as const, imports: ['a.js'] },
		'schemas.js': { type: 'chunk' as const, imports: ['clipboard.js'] },
		'clipboard.js': { type: 'chunk' as const, imports: [] },
		'style.css': { type: 'asset' as const },
	}
	const view = withFlattenedImports(bundle)
	expect(view['entry.js'].imports).toEqual([
		'a.js',
		'b.js',
		'schemas.js',
		'clipboard.js',
	])
	expect(view['b.js'].imports).toEqual(['a.js', 'schemas.js', 'clipboard.js'])
	expect(view['clipboard.js'].imports).toEqual([])
	expect(view['style.css']).toBe(bundle['style.css'])
	expect(bundle['entry.js'].imports).toEqual(['a.js', 'b.js'])
})

test('the installed TanStack Start still has the manifest capture plugin', () => {
	expect(() =>
		flattenClientPreloads(
			tanstackStart({ srcDirectory: 'packages/worker/start' }),
		),
	).not.toThrow()
})

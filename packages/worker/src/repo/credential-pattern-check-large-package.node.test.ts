import { getHeapStatistics } from 'node:v8'
import { expect, test, vi } from 'vitest'
import type * as ModuleSource from '#worker/module-source.ts'
import { buildCredentialPatternCheck } from './credential-pattern-check.ts'

// Samples the heap at every parse. Holding every module's AST at once (the
// old whole-tree Map) peaked near 1 GB on this tree; one AST at a time stays
// far below the bound, which sits under the Worker isolate memory limit.
const heap = vi.hoisted(() => ({ peak: 0, parses: 0 }))
const peakHeapBoundBytes = 400 * 1024 * 1024

vi.mock('#worker/module-source.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof ModuleSource>()
	return {
		...actual,
		parseModuleSource(source: string) {
			heap.parses += 1
			heap.peak = Math.max(heap.peak, getHeapStatistics().used_heap_size)
			return actual.parseModuleSource(source)
		},
	}
})

const targetSourceBytes = 3 * 1024 * 1024
const moduleCount = 300

function generatedModule(index: number, bytes: number) {
	const lines = [
		`import { sharedPrefix } from './shared.ts'`,
		`export const moduleLabel${index} = sharedPrefix + '-${index}'`,
	]
	let size = lines.join('\n').length
	for (let fn = 0; size < bytes; fn += 1) {
		const body = [
			`export function transform${index}_${fn}(input: Array<{ id: string; value: number }>) {`,
			`\tconst label = \`\${moduleLabel${index}}:${fn}\``,
			`\treturn input`,
			`\t\t.filter((item) => item.value > ${fn % 7})`,
			`\t\t.map((item) => ({ ...item, label, score: item.value * ${fn + 1} }))`,
			`\t\t.sort((left, right) => left.score - right.score)`,
			`}`,
		].join('\n')
		lines.push(body)
		size += body.length + 1
	}
	return lines.join('\n')
}

function generatedPackage() {
	const files: Record<string, string> = {
		'package.json': JSON.stringify({
			name: '@example/large-tree',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'large-tree',
				description: 'Generated large source tree.',
				credentials: {
					EXAMPLE_TOKEN: { description: 'Example API token.' },
				},
			},
		}),
		'src/shared.ts': `export const sharedPrefix = 'example'\nexport const tokenKey = 'EXAMPLE_TOKEN'\n`,
	}
	const perModule = Math.ceil(targetSourceBytes / moduleCount)
	const imports: Array<string> = []
	for (let index = 0; index < moduleCount; index += 1) {
		files[`src/lib/module-${index}.ts`] = generatedModule(index, perModule)
		imports.push(`export * from './lib/module-${index}.ts'`)
	}
	files['src/index.ts'] = [
		`import { credential } from 'kody:runtime'`,
		`import { tokenKey } from './shared.ts'`,
		...imports,
		`export async function run() {`,
		`\tconst client = await credential(tokenKey)`,
		`\treturn client.fetch('https://api.example.com/items')`,
		`}`,
	].join('\n')
	return files
}

test('credential publish gate scans a ~3 MB package one module at a time', () => {
	const files = generatedPackage()
	const sourceBytes = Object.entries(files)
		.filter(([path]) => path.endsWith('.ts'))
		.reduce((total, [, source]) => total + source.length, 0)
	expect(sourceBytes).toBeGreaterThanOrEqual(targetSourceBytes)

	const baseline = getHeapStatistics().used_heap_size
	heap.peak = baseline
	heap.parses = 0
	const result = buildCredentialPatternCheck(files)

	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['EXAMPLE_TOKEN'])
	expect(heap.parses).toBeGreaterThan(moduleCount)
	expect(heap.peak - baseline).toBeLessThan(peakHeapBoundBytes)
}, 120_000)

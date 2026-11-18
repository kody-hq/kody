import { expect, test, vi } from 'vitest'
import type * as ModuleSource from '#worker/module-source.ts'
import { credentialStampMaxModuleScanBytes } from '#worker/credentials/credential-stamp.ts'
import { buildCredentialPatternCheck } from './credential-pattern-check.ts'

// Parses of each module source by the credential scans. Their CPU time is
// these parses plus one walk per scan, so a count that grows with the number
// of scans is what ran publish out of CPU on packages with committed builds.
const parses = vi.hoisted(() => new Map<string, number>())

vi.mock('#worker/module-source.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof ModuleSource>()
	return {
		...actual,
		async parseModuleSourceAllowingTypeAssertions(source: string) {
			parses.set(source, (parses.get(source) ?? 0) + 1)
			return await actual.parseModuleSourceAllowingTypeAssertions(source)
		},
	}
})

const moduleCount = 40

function packageWithCommittedBuild(extraFiles: Record<string, string> = {}) {
	const files: Record<string, string> = {
		'package.json': JSON.stringify({
			name: '@example/committed-build',
			exports: { '.': './dist/server/server.js' },
			kody: {
				id: 'committed-build',
				description: 'Package that commits its server build.',
				credentials: {
					EXAMPLE_TOKEN: { description: 'Example API token.' },
				},
			},
		}),
		...extraFiles,
	}
	const imports: Array<string> = []
	for (let index = 0; index < moduleCount; index += 1) {
		files[`dist/server/_assets/chunk-${index}.js`] =
			`export const value${index}=(e)=>e.map((t)=>({...t,score:t.value*${index + 1}}));\n`
		imports.push(`export*from"./_assets/chunk-${index}.js";`)
	}
	files['dist/server/server.js'] = [
		`import{credential as e}from"kody:runtime";`,
		...imports,
		...Object.keys(extraFiles).map((path) => `import"../../${path}";`),
		`export async function run(){const t=await e("EXAMPLE_TOKEN");return t.fetch("https://api.example.com/items?key={{secret:EXAMPLE_TOKEN}}")}`,
	].join('')
	return files
}

function parsesPerModule(files: Record<string, string>) {
	return Object.entries(files)
		.filter(([path]) => path.endsWith('.js'))
		.map(([, source]) => parses.get(source) ?? 0)
}

test('the publish credential check parses each module twice, however many scans read it', async () => {
	parses.clear()
	const files = packageWithCommittedBuild()
	const result = await buildCredentialPatternCheck(files)

	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['EXAMPLE_TOKEN'])
	expect(result.requestPlacementHits).toEqual([
		expect.objectContaining({
			path: 'dist/server/server.js',
			name: 'EXAMPLE_TOKEN',
			part: 'query',
		}),
	])
	// Once for the module index, once for the walk every scan shares.
	expect(new Set(parsesPerModule(files))).toEqual(new Set([2]))
})

test('a module too large for the stamp costs one more index and walk, not one per scan', async () => {
	parses.clear()
	const oversized = `export const table=[${'"padding-padding-padding",'.repeat(
		Math.ceil(credentialStampMaxModuleScanBytes / 26) + 1,
	)}];\n`
	const files = packageWithCommittedBuild({ 'dist/server/big.js': oversized })
	const result = await buildCredentialPatternCheck(files)

	expect(result.ok).toBe(true)
	expect(result.stampKeys).toEqual(['EXAMPLE_TOKEN'])
	expect(Math.max(...parsesPerModule(files))).toBe(4)
})

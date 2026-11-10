import { expect, test, vi } from 'vitest'

const parseCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('./import-specifiers.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./import-specifiers.ts')>()
	return {
		...actual,
		parseBundlerResolvedSpecifiers: (
			...args: Parameters<typeof actual.parseBundlerResolvedSpecifiers>
		) => {
			parseCalls.count += 1
			return actual.parseBundlerResolvedSpecifiers(...args)
		},
	}
})

const { collectUndeclaredBarePackageImports } =
	await import('./bare-package-import-declarations.ts')

test('many entries sharing modules parse each module once', () => {
	const targetCount = 99
	const sourceFiles: Record<string, string> = {
		'package.json': JSON.stringify({
			name: '@synthetic/many',
			dependencies: {},
		}),
		'src/lib/shared.ts': `import { helper } from './helper.ts'\nimport missing from 'left-pad'\nexport const shared = helper\nexport default missing\n`,
		'src/lib/helper.ts': `export const helper = 1\n`,
	}
	const entryPoints = Array.from({ length: targetCount }, (_, index) => {
		const path = `src/exports/target-${index}.ts`
		sourceFiles[path] =
			`import { shared } from '../lib/shared.ts'\nexport default () => shared + ${index}\n`
		return { path }
	})
	parseCalls.count = 0
	const result = collectUndeclaredBarePackageImports({
		manifest: { name: '@synthetic/many', kody: {} } as never,
		sourceFiles,
		entryPoints: entryPoints as never,
		declaredDependencies: [],
	})
	expect(result.undeclared.map((entry) => entry.packageName)).toEqual([
		'left-pad',
	])
	// Every entry plus the two shared modules, once each.
	expect(parseCalls.count).toBe(targetCount + 2)
})

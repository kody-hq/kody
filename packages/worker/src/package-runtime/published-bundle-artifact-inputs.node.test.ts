import { expect, test } from 'vitest'
import type { ModuleImportNodesCache } from './import-specifiers.ts'
import {
	collectPublishedPackageArtifactInputPaths,
	publishedPackageArtifactTargetInputsChanged,
} from './published-bundle-artifact-inputs.ts'

const packageJson = JSON.stringify({
	name: '@alice/multi-export',
	exports: {
		'.': './src/a.ts',
		'./b': './src/b.ts',
		'./c': './src/c.ts',
	},
	kody: {
		id: 'multi-export',
		description: 'Multi-export fixture',
	},
})

const previousFiles = {
	'package.json': packageJson,
	'src/a.ts': `import { shared } from './shared.ts'\nexport default async function a() { return shared('a') }\n`,
	'src/b.ts': `export default async function b() { return 'b' }\n`,
	'src/c.ts': `import { shared } from './shared.ts'\nexport default async function c() { return shared('c') }\n`,
	'src/shared.ts': `export function shared(label: string) { return label }\n`,
	'README.md': 'docs only',
}

test('collectPublishedPackageArtifactInputPaths includes reachable source and bundler root config, not sibling exports', async () => {
	const aPaths = await collectPublishedPackageArtifactInputPaths({
		files: previousFiles,
		entryPoint: 'src/a.ts',
	})
	expect([...aPaths].sort()).toEqual([
		'package.json',
		'src/a.ts',
		'src/shared.ts',
	])

	const bPaths = await collectPublishedPackageArtifactInputPaths({
		files: previousFiles,
		entryPoint: 'src/b.ts',
	})
	expect([...bPaths].sort()).toEqual(['package.json', 'src/b.ts'])

	const withVendor = await collectPublishedPackageArtifactInputPaths({
		files: {
			...previousFiles,
			'node_modules/left-pad/index.js': 'export default 1',
		},
		entryPoint: 'src/b.ts',
	})
	expect(withVendor.has('node_modules/left-pad/index.js')).toBe(true)
	expect(withVendor.has('README.md')).toBe(false)
})

test('publishedPackageArtifactTargetInputsChanged dirties only targets whose reachable inputs changed', async () => {
	const nextBOnly = {
		...previousFiles,
		'src/b.ts': `export default async function b() { return 'b-changed' }\n`,
	}
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/a.ts',
			previousFiles,
			nextFiles: nextBOnly,
		}),
	).toBe(false)
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/b.ts',
			previousFiles,
			nextFiles: nextBOnly,
		}),
	).toBe(true)
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/c.ts',
			previousFiles,
			nextFiles: nextBOnly,
		}),
	).toBe(false)

	const nextShared = {
		...previousFiles,
		'src/shared.ts': `export function shared(label: string) { return label.toUpperCase() }\n`,
	}
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/a.ts',
			previousFiles,
			nextFiles: nextShared,
		}),
	).toBe(true)
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/b.ts',
			previousFiles,
			nextFiles: nextShared,
		}),
	).toBe(false)
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/c.ts',
			previousFiles,
			nextFiles: nextShared,
		}),
	).toBe(true)

	const nextDocsOnly = {
		...previousFiles,
		'README.md': 'docs changed',
	}
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/b.ts',
			previousFiles,
			nextFiles: nextDocsOnly,
		}),
	).toBe(false)

	const nextManifest = {
		...previousFiles,
		'package.json': JSON.stringify({
			name: '@alice/multi-export',
			exports: {
				'.': './src/a.ts',
				'./b': './src/b.ts',
				'./c': './src/c.ts',
			},
			kody: {
				id: 'multi-export',
				description: 'Multi-export fixture changed',
			},
		}),
	}
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/b.ts',
			previousFiles,
			nextFiles: nextManifest,
		}),
	).toBe(true)
})

test('publishedPackageArtifactTargetInputsChanged rebuilds when the graph cannot be proven', async () => {
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/missing.ts',
			previousFiles: {},
			nextFiles: {},
		}),
	).toBe(true)
	expect(
		await publishedPackageArtifactTargetInputsChanged({
			entryPoint: 'src/new.ts',
			previousFiles,
			nextFiles: {
				...previousFiles,
				'src/new.ts': 'export default async function neu() { return 1 }\n',
			},
		}),
	).toBe(true)
})

test('publishedPackageArtifactTargetInputsChanged parses each source once across targets with a shared cache', async () => {
	const cache: ModuleImportNodesCache = new Map()
	for (const entryPoint of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
		const changed = await publishedPackageArtifactTargetInputsChanged({
			entryPoint,
			previousFiles,
			nextFiles: previousFiles,
			importNodesCache: cache,
		})
		expect(changed).toBe(
			await publishedPackageArtifactTargetInputsChanged({
				entryPoint,
				previousFiles,
				nextFiles: previousFiles,
			}),
		)
	}
	const sourcePaths = Object.keys(previousFiles).filter((path) =>
		path.endsWith('.ts'),
	)
	expect(cache.size).toBeGreaterThan(0)
	expect(cache.size).toBeLessThanOrEqual(sourcePaths.length)
})

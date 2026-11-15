import { expect, test } from 'vitest'
import { refreshKodyRuntimeModules } from './runtime-source-modules.ts'
import { materializePublishedArtifactModules } from './module-graph-artifacts.ts'

test('compose artifact then canonical refresh leaves one full runtime', async () => {
	const prefix = 'artifacts/pkg/.__published__/deadbeef'
	const artRuntime = `${prefix}/.__kody_virtual__/runtime.js`
	const materialized = await materializePublishedArtifactModules({
		artifactPrefix: prefix,
		modules: {
			'.__kody_virtual__/runtime.js': 'stale',
			'wake.js':
				'import { packageSecrets } from "./.__kody_virtual__/runtime.js"; export default async function wake(){ return null }',
		},
	})
	expect(materialized[artRuntime]).toContain('__kodyCreateRuntimeObjectProxy')

	const composed = await refreshKodyRuntimeModules({
		'.__kody_virtual__/runtime.js': 'stale-canonical',
		'entry.js': `import wake from "./${prefix}/wake.js"; export default async () => wake()`,
		...materialized,
	})
	const fullPaths = Object.entries(composed)
		.filter(
			([, source]) =>
				typeof source === 'string' &&
				source.includes('__kodyCreateRuntimeObjectProxy'),
		)
		.map(([path]) => path)
	expect(fullPaths).toEqual(['.__kody_virtual__/runtime.js'])
	expect(composed[artRuntime]).toContain('export * from')
	expect(composed[artRuntime]).not.toContain('__kodyCreateRuntimeObjectProxy')
})

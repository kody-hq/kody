import { env } from 'cloudflare:workers'
import { dualMajorNodeModulesFixture } from '@kody-internal/shared/node-modules-resolution.fixture.ts'
import { expect, test } from 'vitest'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

function quoted(value: string) {
	return new RegExp(`["']${value}["']`)
}

/**
 * Publish rebuilds run the real worker bundler. Its built-in lookup only
 * reads the root `node_modules/<name>`, which bound `parser` to the hoisted
 * `codec@4` (no `fromCodePoint`) instead of its nested `codec@7` — the
 * `html-to-text` → `htmlparser2` → `entities@7` failure.
 */
test(
	'package bundles resolve bare imports from the importing file (nested majors win)',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-nested-node-modules',
			sourceFiles: dualMajorNodeModulesFixture,
			entryPoint: 'src/index.ts',
		})
		const source = Object.values(bundle.modules)
			.map((module) => (typeof module === 'string' ? module : ''))
			.join('\n')
		expect(source).toMatch(quoted('codec@7'))
		expect(source).toMatch(quoted('@scope/kit@2:browser'))
		expect(source).toMatch(quoted('codec@4'))
		expect(source).not.toMatch(quoted('@scope/kit@1'))
		expect(source).not.toContain('cjs-entry-should-not-be-used')
	},
)

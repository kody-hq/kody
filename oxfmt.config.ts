import epicOxfmt from '@epic-web/config/oxfmt'
import { defineConfig } from 'oxfmt'

/**
 * Shared Oxfmt config: epic-web preset plus Kody-specific ignores.
 * Oxfmt has no `extends`; spread the preset and override locally.
 */
export default defineConfig({
	...epicOxfmt,
	ignorePatterns: [
		...(epicOxfmt.ignorePatterns ?? []),
		// Prefer the worker env example over a generic `!**/.env.example`.
		'!packages/worker/.env.example',
		// TanStack Router regenerates this file with its own formatter.
		'packages/worker/start/routeTree.gen.ts',
		// Preserve benchmark output exactly as the measuring tools wrote it.
		'tools/framework-comparison/reports/measurements/**',
	],
})

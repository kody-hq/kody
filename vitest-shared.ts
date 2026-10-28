import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotEnv } from 'dotenv'
import { type ViteUserConfig } from 'vitest/config'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
import { suppressThirdPartySourcemapWarnings } from './tools/vite-suppress-sourcemap-warnings.ts'

export const rootDir = fileURLToPath(new URL('.', import.meta.url))
// Scratch trees under `.tmp/` (pre-commit typecheck worktrees, worker dry-run
// outdirs) must not be collected as tests. Each project replaces `test.exclude`
// entirely, so keep this list in one place.
export const sharedTestExclude = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.worktrees/**',
	'**/.tmp/**',
] as const
// Match CI. Workers-unit first Durable Object RPC in a file is ~10s in the
// Vitest pool (decision 0011); a 5s local default timed that out and forced
// `--no-verify`. Also covers workerd-only work such as worker-bundler.
const testTimeout = 20_000

loadDotEnv({
	path: resolve(rootDir, 'packages/worker/.env'),
	quiet: true,
})

export const sharedProjectConfig = {
	plugins: [suppressThirdPartySourcemapWarnings(), markdownAsText()],
	resolve: {
		alias: [
			{
				find: /^#app\//,
				replacement: `${resolve(rootDir, 'packages/worker/src/app')}/`,
			},
			{
				find: /^#client\//,
				replacement: `${resolve(rootDir, 'packages/worker/client')}/`,
			},
			{
				find: /^#universal\//,
				replacement: `${resolve(rootDir, 'packages/worker/universal')}/`,
			},
			{
				find: /^#worker\//,
				replacement: `${resolve(rootDir, 'packages/worker/src')}/`,
			},
			{
				find: /^#mcp\//,
				replacement: `${resolve(rootDir, 'packages/worker/src/mcp')}/`,
			},
		],
	},
	oxc: {
		target: 'es2023',
		jsx: {
			runtime: 'automatic',
			importSource: '@emotion/react',
		},
	},
	test: {
		testTimeout,
		hookTimeout: testTimeout,
		// `validate` runs this suite concurrently with Playwright and two
		// Wrangler servers on 4-core machines; leave a core free so their
		// startup is not starved by test workers. Workers-unit may lower this
		// further under `KODY_VALIDATE_LOAD` (see vitest.workers.config.ts).
		maxWorkers: process.env.CI ? 3 : undefined,
		clearMocks: true,
		mockReset: true,
		setupFiles: [
			resolve(rootDir, 'packages/worker/src/test-support/console-spies.ts'),
		],
		// msw's cookie store probes `typeof localStorage`, which trips Node's
		// experimental localStorage warning in every fork that loads it.
		execArgv: ['--disable-warning=ExperimentalWarning'],
	},
} satisfies ViteUserConfig

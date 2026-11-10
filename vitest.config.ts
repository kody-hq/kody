import { defineConfig } from 'vitest/config'
import { ignoreVitestTeardownRpcError } from './tools/vitest-teardown-rpc.ts'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
import { suppressThirdPartySourcemapWarnings } from './tools/vite-suppress-sourcemap-warnings.ts'

export default defineConfig({
	// The workers pool resolves modules through this root-level Vite server, so
	// the broken-third-party-sourcemap warning filter has to apply here too
	// (see tools/vite-suppress-sourcemap-warnings.ts).
	plugins: [suppressThirdPartySourcemapWarnings(), markdownAsText()],
	test: {
		onUnhandledError: ignoreVitestTeardownRpcError,
		projects: [
			'./vitest.node.config.ts',
			'./vitest.workers.config.ts',
			'./vitest.mcp-e2e.config.ts',
		],
	},
})

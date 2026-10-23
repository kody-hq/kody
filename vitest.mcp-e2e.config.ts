import { resolve } from 'node:path'
import { defineProject, mergeConfig } from 'vitest/config'
import {
	rootDir,
	sharedProjectConfig,
	sharedTestExclude,
} from './vitest-shared.ts'

// This suite is intentionally just a couple of smoke journeys. They share one
// Wrangler test harness (see getSharedMcpE2eServer) and each test seeds its
// own user/org. Concurrent local validation still needs more headroom than an
// isolated run because OAuth + MCP handshakes contend with other suites.
const mcpE2eTimeout = process.env.CI ? 120_000 : 90_000

export default mergeConfig(
	sharedProjectConfig,
	defineProject({
		test: {
			name: 'mcp-e2e',
			environment: 'node',
			include: ['**/*.mcp-e2e.test.ts'],
			exclude: [...sharedTestExclude],
			testTimeout: mcpE2eTimeout,
			hookTimeout: mcpE2eTimeout,
			// Shared harness lives on globalThis; keep one worker and one module
			// graph so files do not cold-boot Wrangler again.
			fileParallelism: false,
			isolate: false,
			maxWorkers: 1,
			setupFiles: [
				resolve(rootDir, 'packages/worker/src/test-support/console-spies.ts'),
				resolve(rootDir, 'tools/vitest-mcp-e2e-setup.ts'),
			],
		},
	}),
)

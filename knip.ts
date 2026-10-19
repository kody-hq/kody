import { defineConfig } from 'knip/config'
import { toolCliEntryFiles } from './tools/knip-tool-entries.ts'

export default defineConfig({
	include: ['files', 'exports', 'types'],
	ignore: [
		'packages/cli/**',
		// Temporary until PR 2 deletes these after the replacement is on main.
		'tools/build-highlight-test-service.ts',
		'tools/build-jobs-test-service.ts',
		'tools/vitest-global-setup-highlight-test-service.ts',
		'tools/vitest-global-setup-jobs-test-service.ts',
		'tools/vitest-global-setup-guide-catalog-modules.ts',
		'tools/vitest-global-setup-worker-bundler-modules.ts',
	],
	workspaces: {
		'.': {
			entry: [
				...toolCliEntryFiles(process.cwd()),
				// Wrangler loads this default export through the generated remote probe config.
				'tools/ci/start-opt-in-probe-worker.ts',
				'e2e/**/*.ts',
				'vitest*.ts',
			],
			project: ['tools/**/*.{ts,js,mjs}', '*.ts', 'e2e/**/*.ts'],
		},
		'packages/worker': {
			paths: {
				'#start/server/*': ['./start/server/*.ts'],
			},
			entry: [
				'start/client.tsx',
				'start/start.ts',
				'start/server.ts',
				'start/router.tsx',
				'start/routeTree.gen.ts',
				'start/routes/**/*.{ts,tsx}',
				'src/mcp/capabilities/**/*.ts',
				'src/mcp/instructions/**/*.ts',
			],
			project: [
				'src/**/*.{ts,tsx}',
				'start/**/*.{ts,tsx}',
				'client/**/*.{ts,tsx}',
				'universal/**/*.{ts,tsx}',
			],
		},
		'packages/jobs-worker': {
			project: ['src/**/*.ts'],
		},
		'packages/highlight-worker': {
			project: ['src/**/*.ts'],
		},
		'packages/api-worker': {
			project: ['src/**/*.ts'],
		},
		'packages/api-docs-worker': {
			project: ['src/**/*.ts'],
		},
		'packages/backup-control-plane': {
			project: ['*.ts'],
		},
		'packages/status': {
			project: ['*.ts'],
		},
		'packages/nx-cache': {
			entry: ['smoke-probe.ts'],
			project: ['*.ts'],
		},
		'packages/shared': {
			entry: ['src/**/*.ts'],
			project: ['src/**/*.ts'],
		},
		'packages/mock-servers/cloudflare': {
			project: ['src/**/*.ts'],
		},
	},
})

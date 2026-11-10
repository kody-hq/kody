import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = (name: string) =>
	fileURLToPath(
		new URL(`../worker/src/test-support/${name}-stub.ts`, import.meta.url),
	)

export default defineConfig({
	resolve: {
		// Same runtime-module stubs the root node config uses.
		alias: {
			'cloudflare:workers': stub('cloudflare-workers'),
			'cloudflare:workflows': stub('cloudflare-workflows'),
		},
	},
	test: {
		environment: 'node',
		include: ['*.node.test.ts'],
		// Match the root node project so a file's console spies start empty in
		// every test whether it runs alone or in the package suite (#5037).
		clearMocks: true,
	},
})

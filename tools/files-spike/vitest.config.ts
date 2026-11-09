import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tools/files-spike/*.spike.test.ts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		maxWorkers: 1,
	},
})

import { expect, test } from 'vitest'
import { spawnTsc } from './run-tsc.ts'

test('spawnTsc applies the 8GB heap floor when NODE_OPTIONS is unset', async () => {
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	const result = await spawnTsc(['--version'], env)
	expect(result.status).toBe(0)
	expect(result.env.NODE_OPTIONS).toBe('--max-old-space-size=8192')
})

test('spawnTsc leaves an explicit heap flag alone', async () => {
	const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
	const result = await spawnTsc(['--version'], env)
	expect(result.status).toBe(0)
	expect(result.env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
})

import { expect, test } from 'vitest'
import {
	forEachScannableModule,
	ScannableModuleAstLimitError,
	scannableModuleIndex,
	shareModulePasses,
} from './module-placeholder-scan.ts'

test('forEachScannableModule finishes each async visit before the next module and before resolving', async () => {
	const events: Array<string> = []
	await forEachScannableModule(
		{
			'src/a.ts': 'export const a = 1\n',
			'src/b.ts': 'export const b = 2\n',
		},
		async (path) => {
			events.push(`start ${path}`)
			await new Promise((resolve) => setTimeout(resolve, 1))
			events.push(`end ${path}`)
		},
		{ sorted: true },
	)
	expect(events).toEqual([
		'start src/a.ts',
		'end src/a.ts',
		'start src/b.ts',
		'end src/b.ts',
	])
})

function threeModules() {
	return {
		'src/c.ts': 'export const c = 3\n',
		'src/a.ts': 'export const a = 1\n',
		'src/b.ts': 'export const b = 2\n',
	}
}

test('shareModulePasses gives every scan the same parse of each module', async () => {
	const files = threeModules()
	const seen: Array<{ scan: string; path: string; parsed: unknown }> = []
	const scan = (name: string) => async () => {
		await forEachScannableModule(files, (path, parsed) => {
			seen.push({ scan: name, path, parsed })
		})
		return name
	}
	const results = await shareModulePasses(files, [
		scan('first'),
		// A scan that itself runs scans joins the same walk.
		async () => await shareModulePasses(files, [scan('second'), scan('third')]),
	])

	expect(results).toEqual(['first', ['second', 'third']])
	expect(seen.map(({ scan, path }) => `${path} ${scan}`)).toEqual([
		'src/a.ts first',
		'src/a.ts second',
		'src/a.ts third',
		'src/b.ts first',
		'src/b.ts second',
		'src/b.ts third',
		'src/c.ts first',
		'src/c.ts second',
		'src/c.ts third',
	])
	for (const path of Object.keys(files)) {
		const parsed = seen.filter((entry) => entry.path === path)
		expect(parsed[0]!.parsed).not.toBeNull()
		expect(new Set(parsed.map((entry) => entry.parsed)).size).toBe(1)
	}
})

test('shareModulePasses lets a scan walk again after the shared walk', async () => {
	const files = threeModules()
	const walks: Array<string> = []
	const [twice, once] = await shareModulePasses(files, [
		async () => {
			let visits = 0
			await forEachScannableModule(files, () => {
				visits += 1
			})
			walks.push('first walk done')
			await forEachScannableModule(files, () => {
				visits += 1
			})
			return visits
		},
		async () => {
			let visits = 0
			await forEachScannableModule(files, () => {
				visits += 1
			})
			return visits
		},
	])

	expect(twice).toBe(6)
	expect(once).toBe(3)
	expect(walks).toEqual(['first walk done'])
})

test('shareModulePasses fails only the scan whose visitor throws, and ends the pass', async () => {
	const files = threeModules()
	const visited: Array<string> = []
	await expect(
		shareModulePasses(files, [
			async () => {
				await forEachScannableModule(files, (path) => {
					if (path === 'src/b.ts') throw new Error('visitor failed')
				})
			},
			async () => {
				await forEachScannableModule(files, (path) => {
					visited.push(path)
				})
			},
		]),
	).rejects.toThrow('visitor failed')
	expect(visited).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])

	// The pass is gone: a later walk of the same map runs on its own.
	const later: Array<string> = []
	await forEachScannableModule(files, (path) => {
		later.push(path)
	})
	expect(later).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts'])
})

test('scannableModuleIndex stops at the syntax node limit and names what it read', async () => {
	const files = threeModules()
	const index = await scannableModuleIndex(files, { maxAstNodes: 10_000 })
	expect(index.moduleAstNodes.map((module) => module.path).sort()).toEqual([
		'src/a.ts',
		'src/b.ts',
		'src/c.ts',
	])
	expect(index.moduleAstNodes.every((module) => module.astNodes > 0)).toBe(true)

	const error = await scannableModuleIndex(files, { maxAstNodes: 1 }).catch(
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(ScannableModuleAstLimitError)
	const limit = error as ScannableModuleAstLimitError
	expect(limit.maxAstNodes).toBe(1)
	expect(limit.moduleCount).toBe(3)
	expect(limit.modules.map((module) => module.path)).toEqual(['src/c.ts'])
	expect(limit.modules[0]?.astNodes).toBeGreaterThan(1)
})

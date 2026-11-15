import { expect, test } from 'vitest'
import { forEachScannableModule } from './module-placeholder-scan.ts'

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

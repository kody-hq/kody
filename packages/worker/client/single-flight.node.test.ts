import { expect, test, vi } from 'vitest'
import { createSingleFlight } from './single-flight.ts'
test('the mutation gate admits one operation before React Query can render pending', async () => {
	const run = createSingleFlight()
	let release!: () => void
	const first = run(
		() =>
			new Promise<void>((resolve) => {
				release = resolve
			}),
	)
	const duplicate = vi.fn(async () => 'duplicate')
	expect(await run(duplicate)).toBeUndefined()
	expect(duplicate).not.toHaveBeenCalled()
	release()
	await first
	expect(await run(async () => 'next')).toBe('next')
})
test('empty results and thrown failures both release the operation gate', async () => {
	const run = createSingleFlight()
	expect(await run(async () => undefined)).toBeUndefined()
	await expect(
		run(async () => {
			throw new Error('failed')
		}),
	).rejects.toThrow('failed')
	expect(await run(async () => 'retry')).toBe('retry')
})

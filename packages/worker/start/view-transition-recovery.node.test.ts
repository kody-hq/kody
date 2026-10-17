import { afterEach, expect, test, vi } from 'vitest'
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
} from '@tanstack/react-router'

afterEach(() => vi.unstubAllGlobals())
function routerWith(
	startViewTransition: (update: () => Promise<void>) => unknown,
) {
	const router = createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory(),
		origin: 'https://motion.test',
		defaultViewTransition: true,
	})
	vi.stubGlobal('document', { startViewTransition })
	return router
}

test('a rejected browser transition starts the route update exactly once', async () => {
	const update = vi.fn(async () => {})
	const router = routerWith(() => {
		throw new DOMException('busy', 'InvalidStateError')
	})
	await router.startViewTransition(update)
	expect(update).toHaveBeenCalledTimes(1)
})

test('a browser that invokes the update then throws cannot repeat it', async () => {
	const update = vi.fn(async () => {})
	const router = routerWith((callback) => {
		void callback()
		throw new Error('browser failure')
	})
	await router.startViewTransition(update)
	expect(update).toHaveBeenCalledTimes(1)
})

test('skipped animation lifecycle rejections do not discard or repeat the update', async () => {
	let callback!: () => Promise<void>
	const update = vi.fn(async () => {})
	const router = routerWith((run) => {
		callback = run
		return {
			ready: Promise.reject(new Error('skipped')),
			finished: Promise.reject(new Error('skipped')),
			updateCallbackDone: Promise.reject(new Error('not started')),
		}
	})
	await router.startViewTransition(update)
	await callback()
	expect(update).toHaveBeenCalledTimes(1)
})

test('the original asynchronous route update error still rejects without retry', async () => {
	const failure = new Error('route commit failed')
	const update = vi.fn(async () => {
		throw failure
	})
	const router = routerWith((run) => {
		const result = run()
		return {
			ready: Promise.reject(failure),
			finished: result,
			updateCallbackDone: result,
		}
	})
	await expect(router.startViewTransition(update)).rejects.toBe(failure)
	expect(update).toHaveBeenCalledTimes(1)
})

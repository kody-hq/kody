import { expect, test, vi } from 'vitest'
import type { EnvironmentModuleNode, HotUpdateOptions } from 'vite'
import {
	touchesComponentBoundary,
	workerWholeGraphReload,
} from './vite-worker-whole-graph-reload.ts'

type FakeNode = {
	id: string
	isSelfAccepting: boolean | undefined
	importers: Set<FakeNode>
}

function node(id: string, isSelfAccepting?: boolean): FakeNode {
	return { id, isSelfAccepting, importers: new Set() }
}

function link(imported: FakeNode, importer: FakeNode) {
	imported.importers.add(importer)
}

/** entry ← index ← origin-handler ← router ← handlers/faq ; entry accepts. */
function serverOnlyGraph() {
	const entry = node('\0virtual:cloudflare/worker-entry', true)
	const index = node('/src/index.ts', false)
	const origin = node('/src/origin-handler.ts', false)
	const router = node('/src/app/router.ts', false)
	const faq = node('/src/app/handlers/faq.ts', false)
	link(index, entry)
	link(origin, index)
	link(router, origin)
	link(faq, router)
	return { entry, faq, router }
}

function asNodes(nodes: Array<FakeNode>) {
	return nodes as unknown as Array<EnvironmentModuleNode>
}

test('a pure server importer chain keeps the incremental update', () => {
	const { faq } = serverOnlyGraph()
	expect(touchesComponentBoundary(asNodes([faq]))).toBe(false)
})

test('a changed component module reloads the whole graph', () => {
	const { router } = serverOnlyGraph()
	const onboarding = node('/client/routes/onboarding.tsx', true)
	link(onboarding, router)
	expect(touchesComponentBoundary(asNodes([onboarding]))).toBe(true)
})

test('a server module imported by a component module reloads the whole graph', () => {
	const { router } = serverOnlyGraph()
	const routerLocation = node('/client/router-location.tsx', true)
	const routes = node('/universal/routes.ts', false)
	link(routerLocation, router)
	link(routes, routerLocation)
	link(routes, router)
	expect(touchesComponentBoundary(asNodes([routes]))).toBe(true)
})

test('cycles in the importer graph terminate', () => {
	const a = node('/a.ts', false)
	const b = node('/b.ts', false)
	link(a, b)
	link(b, a)
	expect(touchesComponentBoundary(asNodes([a]))).toBe(false)
})

function createHookContext(environmentName: string) {
	const send = vi.fn()
	const info = vi.fn()
	const context = {
		environment: {
			name: environmentName,
			config: { root: '/repo' },
			hot: { send },
			logger: { info },
		},
	}
	return { context, send, info }
}

function runHotUpdate(environmentName: string, modules: Array<FakeNode>) {
	const plugin = workerWholeGraphReload()
	const hook = plugin.hotUpdate
	if (!hook || typeof hook !== 'object' || !('handler' in hook)) {
		throw new Error('expected an object-form hotUpdate hook')
	}
	const { context, send, info } = createHookContext(environmentName)
	const result = hook.handler.call(
		context as unknown as ThisParameterType<typeof hook.handler>,
		{
			file: '/repo/packages/worker/client/routes/onboarding.tsx',
			modules: asNodes(modules),
		} as HotUpdateOptions,
	)
	return { result, send, info }
}

test('a component update in a worker environment becomes one whole-graph reload', () => {
	const { router } = serverOnlyGraph()
	const onboarding = node('/client/routes/onboarding.tsx', true)
	link(onboarding, router)
	const { result, send, info } = runHotUpdate('ssr', [onboarding])
	expect(result).toEqual([])
	expect(send).toHaveBeenCalledWith({ type: 'full-reload', path: '*' })
	expect(info).toHaveBeenCalledWith(
		'page reload packages/worker/client/routes/onboarding.tsx (whole worker graph)',
		{ timestamp: true },
	)
})

test('auxiliary worker environments reload the same way', () => {
	const { router } = serverOnlyGraph()
	const component = node('/runtime/panel.tsx', true)
	link(component, router)
	const { result, send } = runHotUpdate('kody_runtime', [component])
	expect(result).toEqual([])
	expect(send).toHaveBeenCalledTimes(1)
})

test("a server-only update leaves Vite's incremental update alone", () => {
	const { faq } = serverOnlyGraph()
	const { result, send } = runHotUpdate('ssr', [faq])
	expect(result).toBeUndefined()
	expect(send).not.toHaveBeenCalled()
})

test('the client environment keeps Vite component HMR', () => {
	const onboarding = node('/client/routes/onboarding.tsx', true)
	link(onboarding, node('/client/entry.tsx', true))
	const { result, send } = runHotUpdate('client', [onboarding])
	expect(result).toBeUndefined()
	expect(send).not.toHaveBeenCalled()
})

test('a file outside the worker graph does not reload it', () => {
	const { result, send } = runHotUpdate('ssr', [])
	expect(result).toBeUndefined()
	expect(send).not.toHaveBeenCalled()
})

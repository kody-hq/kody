import { expect, test, vi } from 'vitest'
import {
	decidePublishRoute,
	parsePublishBinding,
	publishBindingUnavailableMessage,
	publishContextFlagsOffMessage,
	type PublishRouteDeps,
} from './publish-routing.ts'

function deps(overrides: Partial<PublishRouteDeps> = {}) {
	const buildOnContext = vi.fn<PublishRouteDeps['buildOnContext']>(
		async ({ context }) => ({
			kind: 'context',
			buildId: 'pb_1',
			contextName: context ?? 'chain-box',
		}),
	)
	const readBoundContext = vi.fn(async () => null as string | null)
	return {
		flagsEnabled: vi.fn(async () => true),
		readBoundContext,
		chainMayUseContexts: vi.fn(async () => true),
		buildOnContext,
		...overrides,
	} satisfies PublishRouteDeps
}

test('flags off: cloud, no manifest read, and a named context is refused', async () => {
	const d = deps({ flagsEnabled: async () => false })
	await expect(
		decidePublishRoute({ requestedContext: null, packageRef: 'pkg', deps: d }),
	).resolves.toEqual({ kind: 'cloud', via: 'flags_off' })
	expect(d.readBoundContext).not.toHaveBeenCalled()
	await expect(
		decidePublishRoute({ requestedContext: 'nas', packageRef: 'pkg', deps: d }),
	).rejects.toThrow(publishContextFlagsOffMessage)
	await expect(
		decidePublishRoute({
			requestedContext: 'cloud',
			packageRef: 'pkg',
			deps: d,
		}),
	).resolves.toEqual({ kind: 'cloud', via: 'requested' })
})

test('a named context overrides the binding and never falls back', async () => {
	const d = deps({ readBoundContext: vi.fn(async () => 'bound-box') })
	await expect(
		decidePublishRoute({ requestedContext: 'nas', packageRef: 'pkg', deps: d }),
	).resolves.toEqual({
		kind: 'context',
		via: 'requested',
		buildId: 'pb_1',
		contextName: 'nas',
	})
	expect(d.buildOnContext).toHaveBeenCalledWith({
		context: 'nas',
		fallbackToCloud: false,
	})
	expect(d.readBoundContext).not.toHaveBeenCalled()
})

test('a bound package builds only on its bound context', async () => {
	const d = deps({ readBoundContext: vi.fn(async () => 'bound-box') })
	await expect(
		decidePublishRoute({ requestedContext: null, packageRef: 'pkg', deps: d }),
	).resolves.toMatchObject({ kind: 'context', via: 'bound' })
	expect(d.buildOnContext).toHaveBeenCalledWith({
		context: 'bound-box',
		fallbackToCloud: false,
	})
	expect(d.chainMayUseContexts).not.toHaveBeenCalled()
})

test('a bound context that is unavailable fails the publish with the binding error', async () => {
	const d = deps({
		readBoundContext: vi.fn(async () => 'bound-box'),
		buildOnContext: vi.fn(async () => {
			throw new Error(
				'bound-box could not take this run (bound-box was offline).',
			)
		}),
	})
	const error = await decidePublishRoute({
		requestedContext: null,
		packageRef: '@me/big',
		deps: d,
	}).catch((caught: unknown) => caught)
	expect(error).toMatchObject({
		code: 'execution_context_binding_unavailable',
		status: 409,
	})
	expect((error as Error).message).toBe(
		'Package "@me/big" is bound to execution context "bound-box" (package.json kody.publish.execution.context), and that context is not available: bound-box could not take this run (bound-box was offline). Nothing was published; the previously published version is still serving. A bound package never falls back to your chain or Kody cloud. To publish now, name a context for this publish: `kody package publish @me/big --context <name>` (or `--context cloud`), or pass `context` to packagePublishExternalPush. To change the binding, edit kody.publish.execution.context in package.json (remove it to follow your execution chain), commit, push, and publish again. (execution_context_binding_unavailable)',
	)
	expect(d.buildOnContext).toHaveBeenCalledTimes(1)
})

test('a binding to cloud builds on Kody cloud without touching the chain', async () => {
	const d = deps({ readBoundContext: vi.fn(async () => 'cloud') })
	await expect(
		decidePublishRoute({ requestedContext: null, packageRef: 'pkg', deps: d }),
	).resolves.toEqual({ kind: 'cloud', via: 'bound' })
	expect(d.buildOnContext).not.toHaveBeenCalled()
})

test('unbound packages follow the chain, Kody cloud last', async () => {
	const onContext = deps()
	await expect(
		decidePublishRoute({
			requestedContext: null,
			packageRef: 'pkg',
			deps: onContext,
		}),
	).resolves.toMatchObject({
		kind: 'context',
		via: 'chain',
		contextName: 'chain-box',
	})
	expect(onContext.buildOnContext).toHaveBeenCalledWith({
		context: null,
		fallbackToCloud: true,
	})

	const fellThrough = deps({
		buildOnContext: vi.fn(async () => ({ kind: 'cloud' as const })),
	})
	await expect(
		decidePublishRoute({
			requestedContext: null,
			packageRef: 'pkg',
			deps: fellThrough,
		}),
	).resolves.toEqual({ kind: 'cloud', via: 'chain' })

	const cloudOnly = deps({ chainMayUseContexts: vi.fn(async () => false) })
	await expect(
		decidePublishRoute({
			requestedContext: null,
			packageRef: 'pkg',
			deps: cloudOnly,
		}),
	).resolves.toEqual({ kind: 'cloud', via: 'chain' })
	expect(cloudOnly.buildOnContext).not.toHaveBeenCalled()
})

test('parsePublishBinding reads kody.publish.execution.context only', () => {
	const manifest = (kody: unknown) =>
		JSON.stringify({ name: '@me/p', kody: { description: 'p', ...kody } })
	expect(
		parsePublishBinding(
			manifest({ publish: { execution: { context: 'nas' } } }),
		),
	).toBe('nas')
	expect(parsePublishBinding(manifest({}))).toBeNull()
	expect(parsePublishBinding(manifest({ publish: {} }))).toBeNull()
	expect(
		parsePublishBinding(
			manifest({
				publish: { execution: { context: 'nas', fallback: 'chain' } },
			}),
		),
	).toBeNull()
	expect(parsePublishBinding('not json')).toBeNull()
	expect(parsePublishBinding(null)).toBeNull()
})

test('the binding message trims a trailing period from the reason', () => {
	expect(
		publishBindingUnavailableMessage({
			packageRef: 'p',
			context: 'c',
			reason: 'offline.',
		}),
	).toContain('that context is not available: offline. Nothing')
})

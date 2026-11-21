import { Layer, ManagedRuntime } from 'effect'
import { observabilityLayer } from '#worker/effect/observability.ts'

/**
 * One `ManagedRuntime` per binding identity (the Worker `env`, or a D1
 * binding), built on first use and reused for the isolate's lifetime, so
 * layer construction and `Effect.cached` work run once per isolate.
 * Per-request capabilities (`Background`) are provided at the call site.
 *
 * Each runtime keeps its own memo map. A memo map shared across bindings
 * memoizes a static layer such as `RateLimiter.layer` by identity, so a second
 * binding would silently reuse services built on the first binding's D1.
 */
export function runtimePerBinding<Binding extends object, R>(
	build: (binding: Binding) => Layer.Layer<R>,
) {
	const runtimes = new WeakMap<
		Binding,
		ManagedRuntime.ManagedRuntime<R, never>
	>()
	return (binding: Binding) => {
		let runtime = runtimes.get(binding)
		if (!runtime) {
			runtime = ManagedRuntime.make(
				Layer.merge(build(binding), observabilityLayer),
			)
			runtimes.set(binding, runtime)
		}
		return runtime
	}
}

import { Layer, ManagedRuntime } from 'effect'
import { observabilityLayer } from '#worker/effect/observability.ts'

/**
 * One `ManagedRuntime` per Worker `env` identity, built on first use and
 * reused for the isolate's lifetime, so layer construction runs once per
 * isolate. Each runtime keeps its own memo map: a map shared across envs
 * would memoize a static layer by identity and reuse services built on the
 * first env's bindings.
 */
export function runtimePerEnv<Binding extends object, R, E>(
	build: (binding: Binding) => Layer.Layer<R, E>,
) {
	const runtimes = new WeakMap<Binding, ManagedRuntime.ManagedRuntime<R, E>>()
	return (binding: Binding) => {
		let runtime = runtimes.get(binding)
		if (!runtime) {
			runtime = ManagedRuntime.make(
				Layer.provideMerge(build(binding), observabilityLayer),
			)
			runtimes.set(binding, runtime)
		}
		return runtime
	}
}

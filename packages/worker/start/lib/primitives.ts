// The only module that may call useEffect or useLayoutEffect. Each hook names
// one kind of sync that has no render, ref callback, store, or handler home.
// react/exhaustive-deps checks callers of the sync and lifetime hooks.
import {
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	type DependencyList,
	type EffectCallback,
} from 'react'

/** Push render values into a long-lived instance that must not be recreated, such as an editor. */
export function useExternalInstanceSync(
	sync: () => void,
	deps: DependencyList,
) {
	// oxlint-disable-next-line react/exhaustive-deps -- callers' deps are checked through additionalHooks
	useEffect(sync, deps)
}

/** Measure rendered layout before paint. Triggers decide when to re-measure; measure always reads the latest render. Return a cleanup for observers. */
export function useLayoutMeasure(
	measure: EffectCallback,
	triggers: DependencyList,
) {
	const run = useEffectEvent(measure)
	// oxlint-disable-next-line react/exhaustive-deps -- triggers are the re-measure schedule
	useLayoutEffect(() => run(), triggers)
}

/** Own a non-DOM resource for the component lifetime. Return its disposal. */
export function useResourceLifetime(
	acquire: () => () => void,
	deps: DependencyList,
) {
	// oxlint-disable-next-line react/exhaustive-deps -- callers' deps are checked through additionalHooks
	useEffect(acquire, deps)
}

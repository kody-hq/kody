import type { AnyRouter } from '@tanstack/react-router'
import { useRouter } from '@tanstack/react-router'
import { useMatchedPageScope } from './use-matched-page-scope.ts'

const navigationGenerations = new WeakMap<AnyRouter, { value: number }>()

// A departing page can remain mounted while the next route loads. Count
// href-changing navigations from their start so a retained match drops its
// old submissions, including a trip away and back that never unmounts it.
function navigationGeneration(router: AnyRouter) {
	let generation = navigationGenerations.get(router)
	if (!generation) {
		const created = { value: 0 }
		router.subscribe('onBeforeNavigate', ({ hrefChanged }) => {
			if (hrefChanged) created.value += 1
		})
		navigationGenerations.set(router, created)
		generation = created
	}
	return generation
}

function currentActorKey(router: AnyRouter) {
	return (
		router.state.matches[0]?.context as { actorKey?: unknown } | undefined
	)?.actorKey
}

/** Cache writes keep submitted identity; imperative UI effects end on navigation. */
export function useSubmitterScope() {
	const { actorKey, pageLocation } = useMatchedPageScope()
	const router = useRouter()
	const href = pageLocation.href
	return () => {
		const generation = navigationGeneration(router)
		const submitted = generation.value
		// Fragments never reach SSR, so hydrated match context can omit one
		// even when the browser opened this document at an anchor. Capture the
		// browser href now, then require that exact location until completion.
		const submittedHref = router.latestLocation.href
		const sameDocument = submittedHref.split('#')[0] === href.split('#')[0]
		return () =>
			sameDocument &&
			generation.value === submitted &&
			router.latestLocation.href === submittedHref &&
			currentActorKey(router) === actorKey
	}
}

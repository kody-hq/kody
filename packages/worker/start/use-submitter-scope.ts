import { useMatchedPageScope } from './use-matched-page-scope.ts'
import { useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'

/** Cache writes keep submitted identity; imperative UI effects end on navigation. */
export function useSubmitterScope() {
	const { actorKey, pageLocation } = useMatchedPageScope()
	const router = useRouter()
	const href = pageLocation.href
	const current = useRef<object | null>(null)
	useEffect(() => {
		current.current = {}
		// A departing page can remain mounted while the next route loads.
		// Invalidate its old submissions at navigation start, including a trip
		// away and back that never unmounts this retained match.
		const unsubscribe = router.subscribe(
			'onBeforeNavigate',
			({ hrefChanged }) => {
				if (hrefChanged) current.current = {}
			},
		)
		return () => {
			unsubscribe()
			current.current = null
		}
	}, [actorKey, href, router])
	return () => {
		const submission = current.current
		// Fragments never reach SSR, so hydrated match context can omit one
		// even when the browser opened this document at an anchor. Capture the
		// browser href now, then require that exact location until completion.
		const submittedHref = router.latestLocation.href
		const sameDocument = submittedHref.split('#')[0] === href.split('#')[0]
		return () =>
			sameDocument &&
			submission !== null &&
			current.current === submission &&
			router.latestLocation.href === submittedHref
	}
}

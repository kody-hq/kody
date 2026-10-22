import { deepEqual } from '@tanstack/react-router'

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		presentationSearchKeys?: readonly string[]
		filterSearchKeys?: readonly string[]
	}
}
type Location = { pathname: string; searchStr: string; hash: string }
type Match = {
	id: string
	routeId: unknown
	loaderDeps: unknown
	invalid: boolean
	status: string
	error: unknown
	context: unknown
	staticData: {
		presentationSearchKeys?: readonly string[]
		filterSearchKeys?: readonly string[]
	}
}
export type CommittedPage = { location: Location; matches: readonly Match[] }

/** Tracking and return-path keys stay in the URL; they do not authorize a new read. */
function isAttributionSearchKey(key: string) {
	return (
		key === 'ref' ||
		key === 'referrer' ||
		key === 'landing_path' ||
		key.startsWith('utm_')
	)
}

/** Reuse the mounted page scope for declared filters. New reads authorize themselves. */
export function isPresentationNavigation(input: {
	committed: CommittedPage | null
	location: Location
	matches: readonly Match[]
	actorKey: string | null
}) {
	const { committed, location, matches, actorKey } = input
	if (!committed || committed.matches.length !== matches.length) return false
	const committedContext = committed.matches[0]?.context
	const committedActor =
		committedContext &&
		typeof committedContext === 'object' &&
		'actorKey' in committedContext
			? committedContext.actorKey
			: undefined
	if (
		committed.location.pathname !== location.pathname ||
		committed.location.hash !== location.hash ||
		committed.location.searchStr === location.searchStr ||
		committedActor !== actorKey
	)
		return false
	if (
		committed.matches.some((previous, index) => {
			const next = matches[index]!
			return (
				previous.status !== 'success' ||
				previous.error != null ||
				previous.invalid ||
				next.invalid ||
				previous.id !== next.id ||
				previous.routeId !== next.routeId ||
				!deepEqual(previous.loaderDeps, next.loaderDeps)
			)
		})
	)
		return false
	const leaf = matches.at(-1)?.staticData
	const keys = [
		...(leaf?.presentationSearchKeys ?? []),
		...(leaf?.filterSearchKeys ?? []),
	]
	if (!keys?.length) return false
	const before = new URLSearchParams(committed.location.searchStr)
	const after = new URLSearchParams(location.searchStr)
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		if (deepEqual(before.getAll(key), after.getAll(key))) continue
		if (isAttributionSearchKey(key)) continue
		if (!keys.includes(key)) return false
	}
	// Declared filter or presentation keys changed, or only attribution did.
	return true
}

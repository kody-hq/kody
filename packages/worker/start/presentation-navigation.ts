import { deepEqual } from '@tanstack/react-router'

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		presentationSearchKeys?: readonly string[]
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
	staticData: { presentationSearchKeys?: readonly string[] }
}
export type CommittedPage = { location: Location; matches: readonly Match[] }

/** Continue filtering the same mounted payload, never authorize another read. */
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
	const keys = matches.at(-1)?.staticData.presentationSearchKeys
	if (!keys?.length) return false
	const before = new URLSearchParams(committed.location.searchStr)
	const after = new URLSearchParams(location.searchStr)
	let changed = false
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		if (deepEqual(before.getAll(key), after.getAll(key))) continue
		if (!keys.includes(key)) return false
		changed = true
	}
	return changed
}

import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	href: '/account/organizations',
	latestLocation: { href: '/account/organizations#invites' },
	navigate: null as null | ((event: { hrefChanged: boolean }) => void),
	cleanup: null as null | (() => void),
}))
vi.mock('react', () => ({
	useRef: (value: unknown) => ({ current: value }),
	useEffect: (effect: () => () => void) => {
		state.cleanup = effect()
	},
}))
vi.mock('./use-matched-page-scope.ts', () => ({
	useMatchedPageScope: () => ({
		actorKey: 'actor',
		pageLocation: { href: state.href },
	}),
}))
vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({
		latestLocation: state.latestLocation,
		subscribe: (_event: string, callback: typeof state.navigate) => {
			state.navigate = callback
			return () => {
				state.navigate = null
			}
		},
	}),
}))
import { useSubmitterScope } from './use-submitter-scope.ts'
beforeEach(() => {
	state.cleanup?.()
	state.href = '/account/organizations'
	state.latestLocation.href = '/account/organizations#invites'
})
test('SSR document without a fragment allows completion at the browser anchor', () => {
	const active = useSubmitterScope()()
	expect(active()).toBe(true)
})
test('navigation away and back still invalidates a captured submission', () => {
	const active = useSubmitterScope()()
	state.navigate?.({ hrefChanged: true })
	expect(active()).toBe(false)
})
test('a retained page cannot capture a new submission for another document', () => {
	state.latestLocation.href = '/account/waiting#invites'
	expect(useSubmitterScope()()()).toBe(false)
})
test('changed browser fragment or unmount invalidates the submission', () => {
	const active = useSubmitterScope()()
	state.latestLocation.href = '/account/organizations#other'
	expect(active()).toBe(false)
	state.latestLocation.href = '/account/organizations#invites'
	state.cleanup?.()
	expect(active()).toBe(false)
})

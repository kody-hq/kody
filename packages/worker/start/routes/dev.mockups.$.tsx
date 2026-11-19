/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { DevMockupPage } from '../pages/dev-mockups.tsx'
import { loadDevMockups } from '#start/server/dev-mockups'

export const Route = createFileRoute('/dev/mockups/$')({
	staticData: {
		shell: { mode: 'standalone', gutters: 'page' },
		sessionVerification: 'public',
	},
	validateSearch: (search: Record<string, unknown>) => ({
		state: typeof search.state === 'string' ? search.state : undefined,
	}),
	loader: () => loadDevMockups(),
	head: () => ({
		meta: [
			{ title: 'Mockup' },
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: Page,
})

function Page() {
	const { _splat } = Route.useParams()
	const { state } = Route.useSearch()
	return (
		<DevMockupPage
			key={`${_splat}:${state}`}
			name={_splat ?? ''}
			state={state}
		/>
	)
}

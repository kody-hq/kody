/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { DevMockupPage } from '../pages/dev-mockups.tsx'
import { loadDevMockups } from '#start/server/dev-mockups'

/** Workspace-shell mockups: the real rail and content column, signed in. */
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/dev-mockups/$')({
	staticData: {
		navigation: { rail: 'workspace', item: 'overview', itemFromSearch: 'rail' },
		orgScope: {},
	},
	validateSearch: (search: Record<string, unknown>) => ({
		state: typeof search.state === 'string' ? search.state : undefined,
		rail: typeof search.rail === 'string' ? search.rail : undefined,
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
	const { state, rail } = Route.useSearch()
	const navigate = Route.useNavigate()
	return (
		<DevMockupPage
			key={`${_splat}:${state}`}
			name={_splat ?? ''}
			state={state}
			rail={rail}
			onRail={(next) =>
				void navigate({
					search: (prev) => ({ ...prev, rail: next }),
					replace: true,
				})
			}
		/>
	)
}

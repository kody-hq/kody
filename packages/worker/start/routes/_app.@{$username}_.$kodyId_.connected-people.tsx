import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { connectedPeoplePageQuery as pageQuery } from '../package-app-connected-people-query.ts'
import { PackageAppConnectedPeopleRoute } from '../pages/package-app-connected-people.tsx'
import { documentHead } from '../components/document-head.ts'

function readPage(value: unknown) {
	const page = typeof value === 'string' ? Number(value) : value
	return typeof page === 'number' && Number.isInteger(page) && page > 1
		? page
		: undefined
}

export const Route = createFileRoute(
	'/_app/@{$username}_/$kodyId_/connected-people',
)({
	staticData: {
		workspaceLayout: 'resource',
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => ({
		...search,
		page: readPage(search.page),
	}),
	loaderDeps: ({ search }) => ({ page: search.page }),
	context: ({ params, location }) => ({
		pageQueryInput: {
			username: params.username,
			kodyId: params.kodyId,
			page: readPage(new URLSearchParams(location.searchStr).get('page')),
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const result = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	if (result.kind === 'no_access') return <PackageNoAccessPage {...result} />
	return (
		<PackageAppConnectedPeopleRoute
			key={`${pageQueryInput.username}/${pageQueryInput.kodyId}`}
			payload={result.payload}
			actorKey={actorKey}
		/>
	)
}

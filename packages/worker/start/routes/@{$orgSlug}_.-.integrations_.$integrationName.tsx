/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountIntegrationsPage } from '../pages/account-integrations.tsx'
import { loadIntegrationsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadIntegrationsPage',
	loadIntegrationsPage,
	{ staleTime: 60_000 },
)

export const Route = createFileRoute(
	'/@{$orgSlug}_/-/integrations_/$integrationName',
)({
	staticData: {
		workspaceSwitch: {
			section: 'integrations',
			suffix: [{ param: 'integrationName' }],
		},
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'integrations' },
	},
	validateSearch: textSearch,
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			approve: false,
			integrationName: params.integrationName,
			appSlug: undefined,
			name: new URLSearchParams(location.searchStr).get('name') ?? undefined,
			packageId:
				new URLSearchParams(location.searchStr).get('package_id') ?? undefined,
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
	const { payload } = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountIntegrationsPage
			payload={payload}
			currentHref={location.href}
			selection={{
				kind: 'connection',
				connectionName: Route.useParams().integrationName,
			}}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

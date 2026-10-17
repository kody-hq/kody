/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountMcpServersPage } from '../pages/account-mcp-servers.tsx'
import { loadMcpServersPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadMcpServersPage', loadMcpServersPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/mcp-servers_/$serverId')({
	validateSearch: textSearch,
	staticData: {
		workspaceSwitch: {
			section: 'mcp-servers',
			suffix: [{ param: 'serverId' }],
		},
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'mcp-servers' },
	},
	context: ({ params }) => ({
		pageQueryInput: { orgSlug: params.orgSlug, serverId: params.serverId },
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
		<AccountMcpServersPage
			payload={payload}
			currentHref={location.href}
			selection={{ selectedId: Route.useParams().serverId, isCreating: false }}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

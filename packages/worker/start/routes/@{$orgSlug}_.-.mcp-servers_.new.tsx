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

export const Route = createFileRoute('/@{$orgSlug}_/-/mcp-servers_/new')({
	staticData: {
		workspaceSwitch: { section: 'mcp-servers', suffix: ['new'] },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'mcp-servers' },
	},
	validateSearch: textSearch,
	loaderDeps: ({ search }) => search,
	context: ({ params }) => ({
		pageQueryInput: { orgSlug: params.orgSlug, serverId: undefined },
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
			selection={{ selectedId: null, isCreating: true }}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

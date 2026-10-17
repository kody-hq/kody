/** @jsxImportSource @emotion/react */
import { credentialRedirectFor } from '#universal/credential-redirects.ts'
import { textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { redirect, createFileRoute } from '@tanstack/react-router'
import { AccountMcpServersPage } from '../pages/account-mcp-servers.tsx'
import { loadMcpServersPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadMcpServersPage', loadMcpServersPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/mcp-servers')({
	validateSearch: textSearch,
	staticData: {
		workspaceSwitch: { section: 'mcp-servers' },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'mcp-servers' },
	},
	beforeLoad: ({ location, params }) => {
		const href = credentialRedirectFor(
			new URL(location.href, 'https://kody.local'),
		)
		if (href)
			throw redirect({
				href,
				statusCode: 302,
				headers: { 'Cache-Control': 'private, no-store' },
			})
		return {
			pageQueryInput: { orgSlug: params.orgSlug, serverId: undefined },
		}
	},

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
			selection={{ selectedId: null, isCreating: false }}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

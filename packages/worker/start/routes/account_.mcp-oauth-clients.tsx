/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountMcpOauthClientsPage } from '../pages/account-mcp-oauth-clients.tsx'
import { loadMcpOauthClientsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadMcpOauthClientsPage',
	loadMcpOauthClientsPage,
)

export const Route = createFileRoute('/account_/mcp-oauth-clients')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'agents' },
	},
	context: () => ({ pageQueryInput: {} }),
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
		<AccountMcpOauthClientsPage payload={payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

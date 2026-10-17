/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { isAccountConnectionAgent } from '#universal/account-connections.ts'
import { AccountConnectionsPage } from '../pages/account-connections.tsx'
import { loadConnectionsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadConnectionsPage', loadConnectionsPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/agents_/new_/$agent')({
	staticData: {
		workspaceSwitch: { section: 'agents', suffix: ['new', { param: 'agent' }] },
		navigation: { rail: 'workspace', item: 'agents' },
		orgScope: { section: 'agents' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		queryInput: {
			orgSlug: params.orgSlug,
			view: 'new' as const,
			agent: params.agent,
		},
		pageQueryInput: location.pathname + location.searchStr,
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.queryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { orgSlug, agent } = Route.useParams()
	const { payload } = usePageData()
	const { pageQueryInput } = Route.useRouteContext()
	return (
		<AccountConnectionsPage
			view={isAccountConnectionAgent(agent) ? { kind: 'new', agent } : null}
			payload={payload}
			currentHref={pageQueryInput}
			orgSlug={orgSlug}
		/>
	)
}

function usePageData() {
	const { actorKey, queryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, queryInput)).data
}

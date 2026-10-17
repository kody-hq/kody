/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { collectionSearch } from '../filter-search.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AccountWorkflowsPage } from '../pages/account-workflows.tsx'
import { loadWorkflowsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadWorkflowsPage', loadWorkflowsPage, {
	staleTime: 10_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/workflows_/$workflowId')({
	staticData: {
		workspaceSwitch: {
			section: 'workflows',
			suffix: [{ param: 'workflowId' }],
		},
		navigation: { rail: 'workspace', item: 'workflows' },
		orgScope: { section: 'workflows' },
	},
	validateSearch: collectionSearch,
	search: { middlewares: [stripSearchParams({ view: 'active' })] },
	loaderDeps: ({ search }) => ({
		selected: search.selected,
	}),
	beforeLoad: ({ params, search }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			workflowId: params.workflowId,
			selected: search.selected,
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
	const { pageLocation: location, pageQueryInput } = Route.useRouteContext()
	return (
		<AccountWorkflowsPage
			selectedId={
				pageQueryInput.workflowId?.trim() ||
				pageQueryInput.selected?.trim() ||
				null
			}
			payload={payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

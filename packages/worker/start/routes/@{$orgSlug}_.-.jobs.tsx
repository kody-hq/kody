/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { collectionSearch } from '../filter-search.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AccountJobsPage } from '../pages/account-jobs.tsx'
import { loadJobsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadJobsPage', loadJobsPage, {
	staleTime: 10_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/jobs')({
	staticData: {
		workspaceSwitch: { section: 'jobs' },
		navigation: { rail: 'workspace', item: 'jobs' },
		orgScope: { section: 'jobs' },
		presentationSearchKeys: ['q', 'view'],
	},
	validateSearch: collectionSearch,
	search: { middlewares: [stripSearchParams({ view: 'active' })] },
	loaderDeps: ({ search }) => ({
		selected: search.selected,
	}),
	beforeLoad: ({ params, search }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			jobId: undefined,
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
		<AccountJobsPage
			selectedId={pageQueryInput.selected?.trim() || null}
			payload={payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

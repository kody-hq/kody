/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { memoriesInput } from '../memories-input.ts'
import { memoriesSearch } from '../filter-search.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AccountMemoriesPage } from '../pages/account-memories.tsx'
import { loadMemoriesPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadMemoriesPage', loadMemoriesPage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/memories')({
	staticData: {
		workspaceSwitch: { section: 'memories' },
		navigation: { rail: 'workspace', item: 'memories' },
		orgScope: { section: 'memories' },
	},
	validateSearch: memoriesSearch,
	search: { middlewares: [stripSearchParams({ includeDeleted: false })] },
	loaderDeps: ({ search }) => ({
		selected: search.selected,
		q: search.q,
		includeDeleted: search.includeDeleted,
	}),
	beforeLoad: ({ search, params }) => ({
		pageQueryInput: memoriesInput(params.orgSlug, search, undefined),
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: CollectionPage,
})
function CollectionPage() {
	const { payload } = usePageData()
	const { pageLocation: location, pageQueryInput } = Route.useRouteContext()
	const selectedId = pageQueryInput.selected?.trim() || null
	return (
		<AccountMemoriesPage
			payload={payload}
			currentHref={location.href}
			selectedId={selectedId}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

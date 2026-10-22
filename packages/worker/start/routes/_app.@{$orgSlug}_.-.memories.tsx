/** @jsxImportSource @emotion/react */
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { memoriesInput } from '../memories-input.ts'
import { memoriesSearch } from '../filter-search.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AccountMemoriesPage } from '../pages/account-memories.tsx'
import { loadMemoriesPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadMemoriesPage', loadMemoriesPage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/memories')({
	staticData: {
		filterSearchKeys: ['q', 'includeDeleted'],
		workspaceSwitch: { section: 'memories' },
		navigation: { rail: 'workspace', item: 'memories' },
		orgScope: { section: 'memories' },
	},
	validateSearch: memoriesSearch,
	search: { middlewares: [stripSearchParams({ includeDeleted: false })] },
	loaderDeps: ({ search }) => ({
		selected: search.selected,
	}),
	beforeLoad: ({ search, params, context }) => {
		const pageQueryInput = memoriesInput(params.orgSlug, search, undefined)
		return {
			pageQueryInput,
			pageHeadQueryKey: [
				...pageQuery(context.actorKey, pageQueryInput).queryKey,
			],
		}
	},
	shouldReload: ({ context }) => !context.inPlaceNavigation,
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
	const data = usePageData()
	const { pageLocation: location, pageQueryInput } = Route.useRouteContext()
	if (!data) return null
	const { payload } = data
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
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	return useFilteredPageQuery(pageQuery(actorKey, pageQueryInput), [
		actorKey,
		pageLocation.pathname,
	]).data
}

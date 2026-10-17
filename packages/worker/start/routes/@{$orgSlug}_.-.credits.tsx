import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadCreditsPage } from '#start/server/org-credits'
import { OrgCreditsPage } from '../pages/org-credits.tsx'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadCreditsPage', loadCreditsPage, {
	staleTime: 10_000,
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/credits')({
	staticData: {
		workspaceSwitch: { section: 'credits' },
		navigation: { rail: 'workspace', item: 'credits' },
		orgScope: {},
	},
	validateSearch: (search: Record<string, unknown>) => ({
		...search,
		cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
	}),
	loaderDeps: ({ search }) => ({ cursor: search.cursor }),
	context: ({ params, location }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			cursor: new URLSearchParams(location.searchStr).get('cursor'),
			search: location.searchStr,
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
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	return (
		<OrgCreditsPage
			payload={payload}
			actorKey={actorKey ?? 'anonymous'}
			orgSlug={pageQueryInput.orgSlug}
			currentHref={pageLocation.href}
		/>
	)
}

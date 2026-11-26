/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { ExecutionContextsRoute } from '../pages/execution-contexts.tsx'
import {
	executionContextsPageQuery as pageQuery,
	executionContextsPresentationSearchKeys,
	validateExecutionContextsSearch,
} from '../execution-contexts-query.ts'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/execution-contexts')(
	{
		validateSearch: validateExecutionContextsSearch,
		staticData: {
			workspaceSwitch: { section: 'execution-contexts' },
			navigation: { rail: 'workspace', item: 'execution-contexts' },
			orgScope: { section: 'execution-contexts' },
			presentationSearchKeys: executionContextsPresentationSearchKeys,
		},
		loaderDeps: ({ search }) => ({ cursor: search.cursor }),
		shouldReload: ({ context }) => !context.inPlaceNavigation,
		loader: ({ context, preload, params, deps }) =>
			loadPageQuery(
				context.queryClient,
				pageQuery(context.actorKey, {
					orgSlug: params.orgSlug,
					cursor: deps.cursor,
				}),
				preload,
			),
		head: ({ loaderData }) => documentHead(loaderData?.head),
		component: Page,
	},
)
function Page() {
	const params = Route.useParams()
	const { cursor } = Route.useSearch()
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(
		pageQuery(actorKey, { orgSlug: params.orgSlug, cursor }),
	).data
	return (
		<ExecutionContextsRoute
			payload={payload}
			selectedId={null}
			currentHref={pageLocation.href}
		/>
	)
}

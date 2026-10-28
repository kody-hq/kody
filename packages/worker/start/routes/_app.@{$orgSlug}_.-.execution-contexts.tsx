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
		shouldReload: ({ context }) => !context.inPlaceNavigation,
		loader: ({ context, preload, params }) =>
			loadPageQuery(
				context.queryClient,
				pageQuery(context.actorKey, { orgSlug: params.orgSlug }),
				preload,
			),
		head: ({ loaderData }) => documentHead(loaderData?.head),
		component: Page,
	},
)
function Page() {
	const params = Route.useParams()
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(
		pageQuery(actorKey, { orgSlug: params.orgSlug }),
	).data
	return (
		<ExecutionContextsRoute
			payload={payload}
			selectedId={null}
			currentHref={pageLocation.href}
		/>
	)
}

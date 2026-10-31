import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { forksPageQuery as pageQuery } from '../package-forks-query.ts'
import { PackageForksRoute } from '../pages/package-forks.tsx'
import { renderMissingListing } from '../components/community-detail-sections.tsx'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/_app/@{$username}_/$kodyId_/forks')({
	staticData: {
		workspaceLayout: 'resource',
		shell: { gutters: 'page' },
	},
	context: ({ params }) => ({
		pageQueryInput: { username: params.username, kodyId: params.kodyId },
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
	notFoundComponent: NotFoundPage,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const result = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	if (result.kind === 'no_access') return <PackageNoAccessPage {...result} />
	if (result.kind === 'unauthorized')
		return renderMissingListing(
			'Unauthorized',
			'You are not allowed to view this page.',
		)
	return (
		<PackageForksRoute
			key={`${pageQueryInput.username}/${pageQueryInput.kodyId}`}
			payload={result.payload}
		/>
	)
}

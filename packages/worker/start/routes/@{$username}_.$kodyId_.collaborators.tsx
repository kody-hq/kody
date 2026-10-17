import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { collaboratorsPageQuery as pageQuery } from '../package-collaborators-query.ts'
import { PackageCollaboratorsRoute } from '../pages/package-collaborators.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/@{$username}_/$kodyId_/collaborators')({
	staticData: { motionGroup: 'package', shell: { gutters: 'page' } },
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
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const result = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	if (result.kind === 'no_access') return <PackageNoAccessPage {...result} />
	const { payload } = result
	return (
		<PackageCollaboratorsRoute
			key={`${pageQueryInput.username}/${pageQueryInput.kodyId}`}
			payload={payload}
			actorKey={actorKey}
		/>
	)
}

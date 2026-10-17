/** @jsxImportSource @emotion/react */
import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadPackage } from '#start/server/public-data'
import { PackageSettingsRoute } from '../pages/package-settings.tsx'
import { renderMissingListing } from '../components/community-detail-sections.tsx'
import { packageWebhooksQuery } from '../package-webhooks-query.ts'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadPackage', loadPackage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/@{$username}_/$kodyId_/settings')({
	staticData: { motionGroup: 'package', shell: { gutters: 'page' } },
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			...params,
			page: 'settings' as const,
			search: location.searchStr,
		},
	}),
	loader: async ({ context, preload }) => {
		const options = pageQuery(context.actorKey, context.pageQueryInput)
		const page = await loadPageQuery(context.queryClient, options, preload)
		// Webhook access depends on the package permission check above.
		if (context.queryClient.getQueryData(options.queryKey)?.kind === 'page') {
			await context.queryClient.prefetchQuery(
				packageWebhooksQuery(context.actorKey, {
					username: context.pageQueryInput.username,
					kodyId: context.pageQueryInput.kodyId,
				}),
			)
		}
		return page
	},
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const data = usePageData()
	if (data.kind === 'no_access') return <PackageNoAccessPage {...data} />
	if (data.kind !== 'page')
		return renderMissingListing(
			'Unauthorized',
			'You are not allowed to view this page.',
		)
	return (
		<PackageSettingsRoute
			key={`${data.data.username}/${data.data.kodyId}`}
			data={data.data}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

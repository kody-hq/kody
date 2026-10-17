/** @jsxImportSource @emotion/react */
import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { PackageCredentialsRoute } from '../pages/package-credentials.tsx'
import { loadPackageCredentialsPage } from '#start/server/credentials'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadPackageCredentialsPage',
	loadPackageCredentialsPage,
	{ freshAuthorization: true },
)
export const Route = createFileRoute('/@{$username}_/$kodyId_/credentials')({
	staticData: { motionGroup: 'package' },
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			orgSlug: params.username,
			kodyId: params.kodyId,
			view: 'credentials' as const,
			search: [...new URLSearchParams(location.searchStr)],
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
	const result = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	if (result.kind === 'no_access') return <PackageNoAccessPage {...result} />
	const { payload } = result
	return (
		<PackageCredentialsRoute
			key={pageLocation.href}
			payload={payload}
			currentHref={pageLocation.href}
		/>
	)
}

/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { ConnectCredentialRoute } from '../pages/connect-credential.tsx'
import { loadCredentialsPage } from '#start/server/credentials'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadCredentialsPage', loadCredentialsPage, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/credentials_/new')({
	staticData: {
		workspaceSwitch: { section: 'credentials', suffix: ['new'] },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'credentials' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			create: true,
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
	const { payload } = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	return (
		<ConnectCredentialRoute
			key={pageLocation.href}
			data={payload}
			currentHref={pageLocation.href}
		/>
	)
}

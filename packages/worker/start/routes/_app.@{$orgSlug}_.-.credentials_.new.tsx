/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { ConnectCredentialRoute } from '../pages/connect-credential.tsx'
import { loadCredentialsPage } from '#start/server/credentials'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadCredentialsPage', loadCredentialsPage, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/credentials_/new')({
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
	const search = new URLSearchParams(pageLocation.searchStr)
	const allowedHosts: unknown = pageLocation.search.allowedHosts
	// Start serializes repeated query parameters as a JSON array in the URL.
	// Restore the repeated values before passing them to the setup form.
	if (
		Array.isArray(allowedHosts) &&
		allowedHosts.length > 1 &&
		allowedHosts.every(
			(host) =>
				typeof host === 'string' ||
				typeof host === 'number' ||
				typeof host === 'boolean',
		)
	) {
		search.delete('allowedHosts')
		for (const host of allowedHosts) search.append('allowedHosts', String(host))
	}
	return (
		<ConnectCredentialRoute
			key={pageLocation.href}
			data={payload}
			currentHref={pageLocation.href}
			search={search}
		/>
	)
}

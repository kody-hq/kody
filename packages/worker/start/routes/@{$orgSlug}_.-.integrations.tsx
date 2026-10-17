/** @jsxImportSource @emotion/react */
import { credentialRedirectFor } from '#universal/credential-redirects.ts'
import { textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { redirect, createFileRoute } from '@tanstack/react-router'
import { AccountIntegrationsPage } from '../pages/account-integrations.tsx'
import { loadIntegrationsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadIntegrationsPage',
	loadIntegrationsPage,
	{ staleTime: 60_000 },
)

export const Route = createFileRoute('/@{$orgSlug}_/-/integrations')({
	staticData: {
		workspaceSwitch: { section: 'integrations' },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'integrations' },
	},
	beforeLoad: ({ location, params }) => {
		const href = credentialRedirectFor(
			new URL(location.href, 'https://kody.local'),
		)
		if (href)
			throw redirect({
				href,
				statusCode: 302,
				headers: { 'Cache-Control': 'private, no-store' },
			})
		return {
			pageQueryInput: {
				orgSlug: params.orgSlug,
				approve: false,
				integrationName: undefined,
				appSlug: undefined,
				name: new URLSearchParams(location.searchStr).get('name') ?? undefined,
				packageId:
					new URLSearchParams(location.searchStr).get('package_id') ??
					undefined,
			},
		}
	},
	validateSearch: textSearch,
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		name: search.name,
		package_id: search.package_id,
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
	const { payload } = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountIntegrationsPage
			payload={payload}
			currentHref={location.href}
			selection={{ kind: 'list' }}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

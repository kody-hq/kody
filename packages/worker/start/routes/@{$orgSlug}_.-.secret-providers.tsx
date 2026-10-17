/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountSecretProvidersPage } from '../pages/account-secret-providers.tsx'
import { loadSecretProvidersPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadSecretProvidersPage',
	loadSecretProvidersPage,
)

export const Route = createFileRoute('/@{$orgSlug}_/-/secret-providers')({
	staticData: {
		workspaceSwitch: { section: 'secret-providers' },
		navigation: { rail: 'workspace', item: 'secret-providers' },
		orgScope: { section: 'secret-providers' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			approve: false,
			provider:
				new URLSearchParams(location.searchStr).get('provider') ?? undefined,
			ref: new URLSearchParams(location.searchStr).get('ref') ?? undefined,
			packageId:
				new URLSearchParams(location.searchStr).get('package_id') ?? undefined,
			packageName:
				new URLSearchParams(location.searchStr).get('package') ?? undefined,
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
	const { payload } = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountSecretProvidersPage payload={payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

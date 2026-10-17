/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountIntegrationsPage } from '../pages/account-integrations.tsx'
import { loadIntegrationsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/@{$orgSlug}_/-/integrations_/approve')({
	staticData: {
		workspaceSwitch: { section: 'integrations', suffix: ['approve'] },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'integrations' },
	},
	validateSearch: textSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location, params }) =>
		loadIntegrationsPage({
			signal: abortController.signal,
			data: {
				orgSlug: params.orgSlug,
				approve: true,
				integrationName: undefined,
				appSlug: undefined,
				name: new URLSearchParams(location.searchStr).get('name') ?? undefined,
				packageId:
					new URLSearchParams(location.searchStr).get('package_id') ??
					undefined,
			},
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { payload } = Route.useLoaderData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountIntegrationsPage
			payload={payload}
			currentHref={location.href}
			selection={{ kind: 'approval' }}
		/>
	)
}

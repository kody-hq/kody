/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { AccountSecretProvidersPage } from '../pages/account-secret-providers.tsx'
import { loadSecretProvidersPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute(
	'/@{$orgSlug}_/-/secret-providers_/approve',
)({
	staticData: {
		workspaceSwitch: { section: 'secret-providers', suffix: ['approve'] },
		navigation: { rail: 'workspace', item: 'secret-providers' },
		orgScope: { section: 'secret-providers' },
	},
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location, params }) =>
		loadSecretProvidersPage({
			signal: abortController.signal,
			data: {
				orgSlug: params.orgSlug,
				approve: true,
				provider:
					new URLSearchParams(location.searchStr).get('provider') ?? undefined,
				ref: new URLSearchParams(location.searchStr).get('ref') ?? undefined,
				packageId:
					new URLSearchParams(location.searchStr).get('package_id') ??
					undefined,
				packageName:
					new URLSearchParams(location.searchStr).get('package') ?? undefined,
			},
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { payload } = Route.useLoaderData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountSecretProvidersPage payload={payload} currentHref={location.href} />
	)
}

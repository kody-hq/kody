/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'

import { PackageCredentialApprovalRoute } from '../pages/package-credential-approval.tsx'
import { loadCredentialApprovalPage } from '#start/server/credentials'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute(
	'/_app/@{$username}_/$kodyId_/approve-credentials',
)({
	staticData: { workspaceLayout: 'resource' },
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			orgSlug: params.username,
			kodyId: params.kodyId,
			proposal: [...new URLSearchParams(location.searchStr)],
		},
	}),
	preload: false,
	staleTime: 0,
	gcTime: 0,
	loader: ({ context }) =>
		loadCredentialApprovalPage({ data: context.pageQueryInput }),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { pageLocation } = Route.useRouteContext()
	const { payload } = Route.useLoaderData()
	return (
		<PackageCredentialApprovalRoute
			key={pageLocation.href}
			payload={payload}
			currentHref={pageLocation.href}
		/>
	)
}

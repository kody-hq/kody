/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadCapabilityReview } from '#start/server/package-capability-review'
import { AccountPackageApproveCapabilitiesRoute } from '../pages/account-package-approve-capabilities.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute(
	'/@{$username}_/$kodyId_/approve-capabilities',
)({
	staticData: { shell: { mode: 'focused' } },
	preload: false,
	shouldReload: true,
	loader: ({ abortController, params, location }) =>
		loadCapabilityReview({
			signal: abortController.signal,
			data: { ...params, search: location.searchStr },
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const params = Route.useParams()
	return (
		<AccountPackageApproveCapabilitiesRoute
			key={`${params.username}/${params.kodyId}`}
			{...params}
			payload={Route.useLoaderData().payload}
		/>
	)
}

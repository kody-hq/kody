/** @jsxImportSource @emotion/react */
import { rejectActionPageHead } from '../action-page-method.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadBillingCompletion } from '#start/server/billing-completion'
import { AccountBillingSuccessPage } from '../pages/account-billing-success.tsx'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/@{$orgSlug}_/-/billing_/success')({
	staticData: {
		workspaceSwitch: { section: 'billing' },
		navigation: { rail: 'workspace', item: 'billing' },
		orgScope: {},
	},
	server: { handlers: { HEAD: rejectActionPageHead } },
	preload: false,
	staleTime: Infinity,
	shouldReload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location, params }) =>
		loadBillingCompletion({
			data: {
				orgSlug: params.orgSlug,
				sessionId: new URLSearchParams(location.searchStr).get('session_id'),
			},
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	return (
		<AccountBillingSuccessPage
			data={Route.useLoaderData().payload}
			billingPath={`/@${Route.useParams().orgSlug}/-/billing`}
		/>
	)
}

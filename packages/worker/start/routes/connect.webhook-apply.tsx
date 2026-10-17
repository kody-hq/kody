/** @jsxImportSource @emotion/react */
import { connectWebhookInput } from '../connect-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { connectWebhookApplyQuery } from '../connect-approval-queries.ts'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { ConnectWebhookApplyRoute } from '../pages/connect-webhook-apply.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/connect/webhook-apply')({
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => search,
	context: ({ location }) => ({
		pageQueryInput: connectWebhookInput(location.searchStr),
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			connectWebhookApplyQuery(context.actorKey, context.pageQueryInput),
			preload,
		),

	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const href = Route.useRouteContext().pageLocation.href
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { data } = usePageQuery(
		connectWebhookApplyQuery(actorKey, pageQueryInput),
	)
	return <ConnectWebhookApplyRoute key={href} initialData={data.payload} />
}

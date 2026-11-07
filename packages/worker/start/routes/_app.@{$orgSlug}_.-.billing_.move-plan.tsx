/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountBillingMovePlanPage } from '../pages/account-billing-move-plan.tsx'
import { loadMovePlanPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadMovePlanPage', loadMovePlanPage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/billing_/move-plan')(
	{
		staticData: {
			workspaceSwitch: { section: 'billing' },
			navigation: { rail: 'workspace', item: 'billing' },
			orgScope: {},
		},
		loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
			to: search.to,
			interval: search.interval,
			billing: search.billing,
			transfer: search.transfer,
		}),
		context: ({ location, params }) => {
			const search = new URLSearchParams(location.searchStr)
			return {
				pageQueryInput: {
					orgSlug: params.orgSlug,
					to: search.get('to'),
					interval: search.get('interval'),
					billing: search.get('billing'),
					transfer: search.get('transfer'),
				},
			}
		},
		loader: ({ context, preload }) =>
			loadPageQuery(
				context.queryClient,
				pageQuery(context.actorKey, context.pageQueryInput),
				preload,
			),
		head: ({ loaderData }) => documentHead(loaderData?.head),
		component: Page,
	},
)
function Page() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	return (
		<AccountBillingMovePlanPage
			payload={payload}
			currentHref={pageLocation.href}
		/>
	)
}

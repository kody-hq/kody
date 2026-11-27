/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { OrgBillingCheckoutPage } from '../pages/org-billing-checkout.tsx'
import { loadCheckoutLinkPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadCheckoutLinkPage',
	loadCheckoutLinkPage,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/billing_/checkout')({
	staticData: {
		workspaceSwitch: { section: 'billing' },
		navigation: { rail: 'workspace', item: 'billing' },
		orgScope: {},
	},
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		plan: search.plan,
		interval: search.interval,
	}),
	context: ({ location, params }) => {
		const search = new URLSearchParams(location.searchStr)
		return {
			pageQueryInput: {
				orgSlug: params.orgSlug,
				plan: search.get('plan'),
				interval: search.get('interval'),
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
})
function Page() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	return (
		<OrgBillingCheckoutPage payload={payload} currentHref={pageLocation.href} />
	)
}

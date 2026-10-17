/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountWebhooksPage } from '../pages/account-webhooks.tsx'
import { loadWebhooksPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadWebhooksPage', loadWebhooksPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/webhooks')({
	staticData: {
		workspaceSwitch: { section: 'webhooks' },
		navigation: { rail: 'workspace', item: 'webhooks' },
		orgScope: { section: 'webhooks' },
	},
	context: ({ params }) => ({ pageQueryInput: { orgSlug: params.orgSlug } }),
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
	return <AccountWebhooksPage payload={payload} currentHref={location.href} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

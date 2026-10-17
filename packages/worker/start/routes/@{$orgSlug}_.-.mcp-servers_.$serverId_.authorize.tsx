/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadMcpServerAuthorizePage } from '#start/server/mcp-server-authorize'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { documentHead } from '../components/document-head.ts'
import { AccountMcpServerAuthorizePage } from '../pages/account-mcp-server-authorize.tsx'
const pageQuery = createPageQuery(
	'loadMcpServerAuthorizePage',
	loadMcpServerAuthorizePage,
	{ staleTime: 0, gcTime: 0, freshAuthorization: true },
)
export const Route = createFileRoute(
	'/@{$orgSlug}_/-/mcp-servers_/$serverId_/authorize',
)({
	staticData: {
		workspaceSwitch: {
			section: 'mcp-servers',
			suffix: [{ param: 'serverId' }, 'authorize'],
		},
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'mcp-servers' },
	},
	context: ({ params }) => ({
		pageQueryInput: { orgSlug: params.orgSlug, serverId: params.serverId },
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
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	const { pageLocation: location } = Route.useRouteContext()
	return data.payload ? (
		<AccountMcpServerAuthorizePage
			payload={data.payload}
			currentHref={location.href}
		/>
	) : (
		<NotFoundPage />
	)
}

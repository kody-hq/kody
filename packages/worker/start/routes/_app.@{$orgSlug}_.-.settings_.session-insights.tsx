/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgSessionInsights } from '#start/server/org-management'
import { SessionInsightsPage } from '../pages/session-insights.tsx'
const pageQuery = createPageQuery(
	'loadOrgSessionInsights',
	loadOrgSessionInsights,
	{ freshAuthorization: true },
)
export const Route = createFileRoute(
	'/_app/@{$orgSlug}_/-/settings_/session-insights',
)({
	staticData: {
		workspaceSwitch: { section: 'settings', suffix: ['session-insights'] },
		navigation: { rail: 'workspace', item: 'settings' },
		orgScope: {},
		shell: { gutters: 'page' },
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Session insights' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return (
		<SessionInsightsPage key={orgSlug} data={data} queryKey={query.queryKey} />
	)
}

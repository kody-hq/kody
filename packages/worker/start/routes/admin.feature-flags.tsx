/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminFeatureFlagsPage } from '../pages/admin-feature-flags.tsx'
import { loadAdminFeatureFlags } from '#start/server/admin-feature-flags'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminFeatureFlags',
	loadAdminFeatureFlags,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/feature-flags')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'feature-flags' },
	},
	context: () => ({ pageQueryInput: undefined }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: FeatureFlagsPage,
})
function FeatureFlagsPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminFeatureFlagsPage payload={data.payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

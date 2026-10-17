import { createFileRoute } from '@tanstack/react-router'
import {
	createPageQuery,
	ensurePageQuery,
	usePageQuery,
} from '../page-query.ts'
import { loadApprovalBundle } from '#start/server/approval-bundles'
import { ApprovalBundleRoute } from '../pages/approval-bundle.tsx'
const pageQuery = createPageQuery('loadApprovalBundle', loadApprovalBundle, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/approvals/$bundleId')({
	staticData: {
		navigation: { rail: 'workspace', item: 'approvals' },
		orgScope: {},
		shell: { mode: 'focused' },
	},
	context: ({ params }) => ({
		pageQueryInput: { orgSlug: params.orgSlug, bundleId: params.bundleId },
	}),
	loader: async ({ context, preload }) => {
		await ensurePageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		)
	},
	head: () => ({
		meta: [
			{ title: 'Review approvals' },
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: Page,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const options = pageQuery(actorKey, pageQueryInput)
	const { data: payload } = usePageQuery(options)
	return (
		<ApprovalBundleRoute
			key={`${actorKey}:${pageQueryInput.orgSlug}:${pageQueryInput.bundleId}`}
			payload={payload}
			orgSlug={pageQueryInput.orgSlug}
			bundleId={pageQueryInput.bundleId}
			queryKey={options.queryKey}
		/>
	)
}

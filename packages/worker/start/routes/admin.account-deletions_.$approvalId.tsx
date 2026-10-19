/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminAccountDeletionApprovalPage } from '../pages/admin-account-deletion-approval.tsx'
import { loadAdminAccountDeletionApproval } from '#start/server/admin-account-deletion'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery(
	'loadAdminAccountDeletionApproval',
	loadAdminAccountDeletionApproval,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/account-deletions_/$approvalId')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'users' },
	},
	loaderDeps: ({ search }) => search,
	beforeLoad: ({ location, params }) => ({
		pageQueryInput: {
			approvalId: params.approvalId,
			returnTo: location.pathname + location.searchStr,
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: ApprovalPage,
})

function ApprovalPage() {
	const data = usePageData()
	const { approvalId } = Route.useParams()
	const { pageLocation: location } = Route.useRouteContext()
	if (data.forbidden || !data.approval) return <p>Forbidden</p>
	return (
		<AdminAccountDeletionApprovalPage
			approvalId={approvalId}
			approval={data.approval}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

/** @jsxImportSource @emotion/react */
import { adminPageNumber } from '../admin-read-input.ts'
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminSystemEmailPage } from '../pages/admin-system-email.tsx'
import { loadAdminSystemEmail } from '#start/server/admin-system-email'
import { documentHead } from '../components/document-head.ts'
import { readEmailMessageViewParam } from '#universal/email-message-view.ts'
const pageQuery = createPageQuery(
	'loadAdminSystemEmail',
	loadAdminSystemEmail,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/admin/system-email')({
	staticData: {
		filterSearchKeys: ['page', 'pageSize', 'view'],
		navigation: { rail: 'admin', item: 'system-email' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({ messageId: search.messageId }),
	beforeLoad: ({ location, context }) => {
		const pageQueryInput = {
			returnTo: location.pathname,
			page: adminPageNumber(
				new URLSearchParams(location.searchStr).get('page'),
				1,
			),
			pageSize: adminPageNumber(
				new URLSearchParams(location.searchStr).get('pageSize'),
				25,
				100,
			),
			messageId: new URLSearchParams(location.searchStr).get('messageId'),
			view: readEmailMessageViewParam(new URLSearchParams(location.searchStr)),
		}
		return {
			pageQueryInput,
			pageHeadQueryKey: [
				...pageQuery(context.actorKey, pageQueryInput).queryKey,
			],
		}
	},
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: SystemEmailPage,
})
function SystemEmailPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	if (!data) return null
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminSystemEmailPage payload={data.payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	return useFilteredPageQuery(pageQuery(actorKey, pageQueryInput), [
		actorKey,
		pageLocation.pathname,
	]).data
}

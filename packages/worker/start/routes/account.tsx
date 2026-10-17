/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '../pages/account.tsx'
import { loadAccountPage } from '#start/server/account-page'
const pageQuery = createPageQuery('loadAccountPage', loadAccountPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/account')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'account', item: 'profile' },
	},
	// Account data is independent of presentation and attribution parameters.
	context: () => ({ pageQueryInput: '' }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: () => ({ meta: [{ title: 'Account settings' }] }),
	component: AccountRoute,
})
function AccountRoute() {
	const { payloads } = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountPage
			view="profile"
			payloads={payloads}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

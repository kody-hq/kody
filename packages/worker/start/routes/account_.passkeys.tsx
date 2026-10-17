/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountPasskeysPage } from '../pages/account-passkeys.tsx'
import { loadAccountSecurity } from '#start/server/account-security'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadAccountSecurity', loadAccountSecurity, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/account_/passkeys')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'account', item: 'security' },
	},
	context: () => ({ pageQueryInput: 'passkeys' as const }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: SecurityPage,
})
function SecurityPage() {
	const mutationContext = Route.useRouteContext()
	const mutationQueryKey = pageQuery(
		mutationContext.actorKey,
		mutationContext.pageQueryInput,
	).queryKey
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	if (data.page !== 'passkeys') throw new Error('Unexpected security page')
	return (
		<AccountPasskeysPage
			queryKey={mutationQueryKey}
			payload={data.payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

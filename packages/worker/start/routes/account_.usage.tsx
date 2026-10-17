/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery } from '../page-query.ts'
import { creditTopUpHead } from '../credit-top-up-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadUsagePage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadUsagePage', loadUsagePage, {
	staleTime: 10_000,
})

export const Route = createFileRoute('/account_/usage')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'usage' },
	},
	server: { middleware: [creditTopUpHead] },
	loaderDeps: ({ search }) => search,
	context: ({ location }) => {
		const search = new URLSearchParams(location.searchStr)
		return {
			pageQueryInput: {
				credits: search.get('credits'),
				error: search.get('error'),
				topup: search.get('topup'),
				sessionId: search.get('session_id'),
				hash: location.hash,
				navigationSearch: [...search],
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
})

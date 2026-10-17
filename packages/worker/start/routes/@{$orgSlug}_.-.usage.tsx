/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { creditTopUpHead } from '../credit-top-up-head.ts'
import { completeCreditTopUp } from '#start/server/credit-top-up-completion'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { AccountUsagePage } from '../pages/account-usage.tsx'
import { loadUsagePage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadUsagePage', loadUsagePage, {
	staleTime: 10_000,
	freshAuthorization: true,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/usage')({
	staticData: {
		workspaceSwitch: { section: 'usage' },
		navigation: { rail: 'workspace', item: 'usage' },
		orgScope: {},
	},
	server: { middleware: [creditTopUpHead] },
	preloadStaleTime: 0,
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		credits: search.credits,
		error: search.error,
		topup: search.topup,
		session_id: search.session_id,
	}),
	context: ({ location, params }) => {
		const search = new URLSearchParams(location.searchStr)
		return {
			pageQueryInput: {
				orgSlug: params.orgSlug,
				credits: search.get('credits'),
				error: search.get('error'),
				topup: search.get('topup'),
				sessionId: search.get('session_id'),
			},
		}
	},
	loader: async ({ context, preload }) => {
		const input = context.pageQueryInput
		if (input.topup === 'success' && input.sessionId?.trim()) {
			if (preload) return { head: undefined }
			const result = await completeCreditTopUp({
				data: { orgSlug: input.orgSlug, sessionId: input.sessionId },
			})
			throw redirect({ href: result.href, statusCode: 302 })
		}
		return loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		)
	},
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const mutationContext = Route.useRouteContext()
	const mutationQueryKey = pageQuery(
		mutationContext.actorKey,
		mutationContext.pageQueryInput,
	).queryKey
	const { payload } = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountUsagePage
			queryKey={mutationQueryKey}
			orgSlug={mutationContext.pageQueryInput.orgSlug}
			payload={payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

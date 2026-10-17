/** @jsxImportSource @emotion/react */
import { secretsSearch } from '../filter-search.ts'
import { secretsInput } from '../secrets-input.ts'
import { credentialRedirectFor } from '#universal/credential-redirects.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { redirect, createFileRoute } from '@tanstack/react-router'
import { AccountSecretsPage } from '../pages/account-secrets.tsx'
import { loadSecretsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadSecretsPage', loadSecretsPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute('/@{$orgSlug}_/-/secrets')({
	staticData: {
		workspaceSwitch: { section: 'secrets' },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'secrets' },
	},
	beforeLoad: ({ params, location }) => {
		const href = credentialRedirectFor(
			new URL(location.href, 'https://kody.local'),
		)
		if (href)
			throw redirect({
				href,
				statusCode: 302,
				headers: { 'Cache-Control': 'private, no-store' },
			})
		return {
			pageQueryInput: secretsInput(params.orgSlug, location.searchStr),
		}
	},
	validateSearch: secretsSearch,
	loaderDeps: ({ search }) => search,

	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: SecretsPage,
})
function SecretsPage() {
	const { payload } = usePageData()
	const { pageLocation: location, pageQueryInput } = Route.useRouteContext()
	return (
		<AccountSecretsPage
			packageApproval={false}
			payload={payload}
			currentHref={location.href}
			selection={{
				selectedId: pageQueryInput.selectedSecretId,
				isCreating: pageQueryInput.create,
			}}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}

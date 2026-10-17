/** @jsxImportSource @emotion/react */
import { secretsSearch } from '../filter-search.ts'
import { secretsInput } from '../secrets-input.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountSecretsPage } from '../pages/account-secrets.tsx'
import { loadSecretsPage } from '#start/server/account-collections'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadSecretsPage', loadSecretsPage, {
	staleTime: 60_000,
})

export const Route = createFileRoute(
	'/@{$orgSlug}_/-/secrets_/session/$sessionId/$secretName',
)({
	staticData: {
		workspaceSwitch: {
			section: 'secrets',
			suffix: ['session', { param: 'sessionId' }, { param: 'secretName' }],
		},
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'secrets' },
	},
	validateSearch: secretsSearch,
	loaderDeps: ({ search }) => search,
	context: ({ params, location }) => ({
		pageQueryInput: secretsInput(params.orgSlug, location.searchStr, {
			scope: 'session',
			name: params.secretName,
			sessionId: params.sessionId,
		}),
	}),
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

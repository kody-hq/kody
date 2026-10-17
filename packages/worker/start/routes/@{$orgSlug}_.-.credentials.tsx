/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { AccountCredentialsRoute } from '../pages/account-credentials.tsx'
import {
	credentialsPageQuery as pageQuery,
	credentialPresentationSearchKeys,
	validateCredentialSearch,
} from '../credentials-query.ts'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/@{$orgSlug}_/-/credentials')({
	validateSearch: validateCredentialSearch,
	staticData: {
		workspaceSwitch: { section: 'credentials' },
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'credentials' },
		presentationSearchKeys: credentialPresentationSearchKeys,
	},
	shouldReload: ({ context }) => !context.presentationOnly,
	loader: ({ context, preload, params }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { orgSlug: params.orgSlug }),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const params = Route.useParams()
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(
		pageQuery(actorKey, { orgSlug: params.orgSlug }),
	).data
	return (
		<AccountCredentialsRoute
			payload={payload}
			selectedId={null}
			currentHref={pageLocation.href}
		/>
	)
}

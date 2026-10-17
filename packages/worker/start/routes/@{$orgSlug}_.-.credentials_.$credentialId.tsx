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
export const Route = createFileRoute(
	'/@{$orgSlug}_/-/credentials_/$credentialId',
)({
	validateSearch: validateCredentialSearch,
	staticData: {
		workspaceSwitch: {
			section: 'credentials',
			suffix: [{ param: 'credentialId' }],
		},
		navigation: { rail: 'workspace', item: 'credentials' },
		orgScope: { section: 'credentials' },
		presentationSearchKeys: credentialPresentationSearchKeys,
	},
	shouldReload: ({ context }) => !context.presentationOnly,
	loader: ({ context, preload, params }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, {
				orgSlug: params.orgSlug,
				credentialId: params.credentialId,
			}),
			preload,
		),

	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const params = Route.useParams()
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(
		pageQuery(actorKey, {
			orgSlug: params.orgSlug,
			credentialId: params.credentialId,
		}),
	).data
	return (
		<AccountCredentialsRoute
			payload={payload}
			selectedId={params.credentialId}
			currentHref={pageLocation.href}
		/>
	)
}

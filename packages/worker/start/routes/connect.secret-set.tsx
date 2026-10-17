/** @jsxImportSource @emotion/react */
import { connectSecretsInput } from '../connect-input.ts'
import { credentialRedirectFor } from '#universal/credential-redirects.ts'
import { redirect, createFileRoute } from '@tanstack/react-router'
import { connectSecretSetQuery } from '../connect-secret-set-query.ts'
import { loadPageQuery } from '../page-query.ts'
import { ConnectSecretSetRoute } from '../pages/connect-secret-set.tsx'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/connect/secret-set')({
	beforeLoad: ({ location }) => {
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
			pageQueryInput: connectSecretsInput(location.searchStr),
		}
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => search,

	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			connectSecretSetQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { actorKey, pageLocation } = Route.useRouteContext()
	return (
		<ConnectSecretSetRoute
			key={pageLocation.href}
			actorKey={actorKey}
			currentHref={pageLocation.href}
		/>
	)
}

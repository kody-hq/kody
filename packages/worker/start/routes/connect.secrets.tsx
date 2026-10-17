/** @jsxImportSource @emotion/react */
import { connectSecretsInput } from '../connect-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { connectSecretsQuery } from '../connect-approval-queries.ts'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { ConnectSecretsRoute } from '../pages/connect-secrets.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/connect/secrets')({
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => search,
	context: ({ location }) => ({
		pageQueryInput: connectSecretsInput(location.searchStr),
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			connectSecretsQuery(context.actorKey, context.pageQueryInput),
			preload,
		),

	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const href = Route.useRouteContext().pageLocation.href
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { data } = usePageQuery(connectSecretsQuery(actorKey, pageQueryInput))
	return <ConnectSecretsRoute key={href} initialData={data.payload} />
}

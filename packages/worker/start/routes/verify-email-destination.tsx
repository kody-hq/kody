/** @jsxImportSource @emotion/react */
import { verifyEmailDestinationHead } from '#start/server/action-page-http'
import { createFileRoute } from '@tanstack/react-router'
import { loadVerifyEmailDestination } from '#start/server/action-page'
import { VerifyEmailRoute } from '../pages/verify-email.tsx'

export const Route = createFileRoute('/verify-email-destination')({
	server: { handlers: { HEAD: verifyEmailDestinationHead } },
	preload: false,
	staleTime: Infinity,
	shouldReload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => {
		const search = new URLSearchParams(location.searchStr)
		return loadVerifyEmailDestination({ data: { token: search.get('token') } })
	},
	head: ({ loaderData }) => ({
		meta: [{ title: loaderData?.title ?? 'Kody' }],
	}),
	component: Page,
})
function Page() {
	const data = Route.useLoaderData()
	return <VerifyEmailRoute data={data} />
}

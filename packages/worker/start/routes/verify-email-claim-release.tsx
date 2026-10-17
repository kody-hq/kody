/** @jsxImportSource @emotion/react */
import { rejectActionPageHead } from '../action-page-method.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadVerifyEmailClaimRelease } from '#start/server/action-page'
import { VerifyEmailRoute } from '../pages/verify-email.tsx'

export const Route = createFileRoute('/verify-email-claim-release')({
	server: { handlers: { HEAD: rejectActionPageHead } },
	preload: false,
	staleTime: Infinity,
	shouldReload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => {
		const search = new URLSearchParams(location.searchStr)
		return loadVerifyEmailClaimRelease({ data: { token: search.get('token') } })
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

/** @jsxImportSource @emotion/react */
import { unsubscribeTipsPost } from '#start/server/action-page-http'
import { rejectActionPageHead } from '../action-page-method.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadUnsubscribeTips } from '#start/server/action-page'
import { UnsubscribeTipsRoute } from '../pages/unsubscribe-tips.tsx'

export const Route = createFileRoute('/unsubscribe/tips')({
	server: {
		handlers: { HEAD: rejectActionPageHead, POST: unsubscribeTipsPost },
	},
	preload: false,
	staleTime: Infinity,
	shouldReload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => {
		const search = new URLSearchParams(location.searchStr)
		return loadUnsubscribeTips({ data: { token: search.get('token') } })
	},
	head: ({ loaderData }) => ({
		meta: [{ title: loaderData?.title ?? 'Kody' }],
	}),
	component: Page,
})
function Page() {
	const data = Route.useLoaderData()
	return <UnsubscribeTipsRoute data={data} />
}

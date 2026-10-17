/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadPendingVerification } from '#start/server/pending-verification'
import { PendingVerificationPage } from '../pages/pending-verification.tsx'

export const Route = createFileRoute('/pending-verification')({
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location }) =>
		loadPendingVerification({
			signal: abortController.signal,
			data: location.searchStr,
		}),
	head: () => ({ meta: [{ title: 'Verify your email' }] }),
	component: Page,
})

function Page() {
	return <PendingVerificationPage data={Route.useLoaderData()} />
}

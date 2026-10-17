/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadVerifyPage } from '#start/server/verify'
import { VerifyRoute } from '../pages/verify.tsx'

export const Route = createFileRoute('/verify')({
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location }) =>
		loadVerifyPage({
			signal: abortController.signal,
			data: location.searchStr,
		}),
	head: () => ({ meta: [{ title: 'Two-factor authentication' }] }),
	component: VerifyRoute,
})

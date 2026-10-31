/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadVerifyPage } from '#start/server/verify'
import { verifyDocumentPost } from '#start/server/auth-document-protocol'
import { VerifyRoute } from '../pages/verify.tsx'

export const Route = createFileRoute('/verify')({
	server: { handlers: { POST: verifyDocumentPost } },
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location }) =>
		loadVerifyPage({
			signal: abortController.signal,
			data: location.searchStr,
		}),
	head: () => ({ meta: [{ title: 'Two-factor authentication' }] }),
	component: VerifyRoute,
})

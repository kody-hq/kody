import { connectSecretSetRedirect } from '#universal/credential-redirects.ts'
import { redirect, createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/connect/secret-set')({
	head: staticDocumentHead('connectSecretSet'),
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) => {
		const href = connectSecretSetRedirect(
			new URL(location.href, 'https://kody.local'),
		)
		throw redirect({
			href,
			statusCode: 302,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	},
})

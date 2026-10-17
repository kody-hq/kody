import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { redirectCredentialEntry } from '#start/server/credential-redirect'
export const Route = createFileRoute('/connect/credential')({
	head: staticDocumentHead('connectCredential'),
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) =>
		redirectCredentialEntry({ data: location.pathname + location.searchStr }),
})

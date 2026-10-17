import { createFileRoute } from '@tanstack/react-router'
import { redirectCredentialEntry } from '#start/server/credential-redirect'
export const Route = createFileRoute('/account_/credentials')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'credentials' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) =>
		redirectCredentialEntry({ data: location.pathname + location.searchStr }),
})

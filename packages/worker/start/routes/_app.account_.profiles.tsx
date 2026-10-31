import { createFileRoute } from '@tanstack/react-router'
import { redirectProfilesEntry } from '#start/server/profiles'
export const Route = createFileRoute('/_app/account_/profiles')({
	staticData: {
		navigation: { rail: 'workspace', item: 'profiles' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) =>
		redirectProfilesEntry({
			data: location.pathname + location.searchStr,
		}),
})

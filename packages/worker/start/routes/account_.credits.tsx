import { createFileRoute } from '@tanstack/react-router'
import { redirectAccountCredits } from '#start/server/org-navigation'
export const Route = createFileRoute('/account_/credits')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'usage' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) =>
		redirectAccountCredits({ data: location.pathname + location.searchStr }),
})

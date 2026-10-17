import { createFileRoute } from '@tanstack/react-router'
import { resolveOrgAlias } from '#start/server/org-alias'
export const Route = createFileRoute('/account_/connections')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'connections' },
	},
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		resolveOrgAlias({
			data:
				location.pathname +
				location.searchStr +
				(location.hash ? `#${location.hash}` : ''),
		}),
})

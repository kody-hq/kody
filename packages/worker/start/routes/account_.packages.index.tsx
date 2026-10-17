import { createFileRoute } from '@tanstack/react-router'
import { resolveOrgAlias } from '#start/server/org-alias'
export const Route = createFileRoute('/account_/packages/')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'packages' },
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

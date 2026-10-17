import { rejectActionPageHead } from '../action-page-method.ts'
import { createFileRoute } from '@tanstack/react-router'
import { resolveOrgAlias } from '#start/server/org-alias'
export const Route = createFileRoute('/account_/billing_/success')({
	staticData: {
		motionGroup: 'account',
		navigation: { rail: 'workspace', item: 'billing' },
	},
	server: { handlers: { HEAD: rejectActionPageHead } },
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

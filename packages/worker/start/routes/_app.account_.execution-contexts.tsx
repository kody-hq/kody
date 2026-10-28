import { createFileRoute } from '@tanstack/react-router'
import { redirectExecutionContextsEntry } from '#start/server/execution-contexts'
export const Route = createFileRoute('/_app/account_/execution-contexts')({
	staticData: {
		navigation: { rail: 'workspace', item: 'execution-contexts' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	beforeLoad: ({ location }) =>
		redirectExecutionContextsEntry({
			data: location.pathname + location.searchStr,
		}),
})

/** @jsxImportSource @emotion/react */
import { loadActivityQuery } from '../activity-query.ts'
import { activityInput } from '../activity-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountActivityPage } from '../pages/account-activity.tsx'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/activity_/$runId')({
	staticData: {
		filterSearchKeys: [
			'view',
			'status',
			'surface',
			'error_triage',
			'triage',
			'cursor',
		],
		workspaceSwitch: { section: 'activity', suffix: [{ param: 'runId' }] },
		navigation: { rail: 'workspace', item: 'activity' },
		orgScope: { section: 'activity' },
	},
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		selected: search.selected,
	}),
	beforeLoad: ({ params, location }) => ({
		pageQueryInput: activityInput(
			params.orgSlug,
			location.searchStr,
			params.runId,
		),
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadActivityQuery(
			context.queryClient,
			context.actorKey,
			context.pageQueryInput,
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AccountActivityPage
			actorKey={actorKey}
			pageQueryInput={pageQueryInput}
			currentHref={location.href}
		/>
	)
}

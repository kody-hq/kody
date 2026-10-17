/** @jsxImportSource @emotion/react */
import { loadActivityQuery } from '../activity-query.ts'
import { activityInput } from '../activity-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AccountActivityPage } from '../pages/account-activity.tsx'
import { documentHead } from '../components/document-head.ts'

export const Route = createFileRoute('/@{$orgSlug}_/-/activity_/$runId')({
	staticData: {
		workspaceSwitch: { section: 'activity', suffix: [{ param: 'runId' }] },
		navigation: { rail: 'workspace', item: 'activity' },
		orgScope: { section: 'activity' },
	},
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		selected: search.selected,
		view: search.view,
		status: search.status,
		surface: search.surface,
		error_triage: search.error_triage,
		triage: search.triage,
		cursor: search.cursor,
	}),
	context: ({ params, location }) => ({
		pageQueryInput: activityInput(
			params.orgSlug,
			location.searchStr,
			params.runId,
		),
	}),
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

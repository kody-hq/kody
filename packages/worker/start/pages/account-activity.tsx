/** @jsxImportSource @emotion/react */
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { activityQuery } from '../activity-query.ts'
import { useRouter } from '@tanstack/react-router'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { renderActivityRunDetail } from './account-activity-detail.tsx'
import {
	activityEmptyLabel,
	activityErrorReviewPrompt,
	activityRoute,
	buildActivitySearch,
	formatDurationMs,
	readStatusFilter,
	readSurfaceFilter,
	readTriageFilter,
	readViewFilter,
	runAttributionSubtitle,
	runDisplayName,
	statusColor,
	statusLabel,
	statusFilterOptions,
	surfaceFilterOptions,
	surfaceLabel,
	triageFilterOptions,
	viewFilterOptions,
} from './account-activity-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import {
	RecordTable,
	RecordTableSelect,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
import { renderWorkflowNameCell } from './workflow-name-display.tsx'
import {
	defaultAccountActivityStatusFilter,
	defaultAccountActivityTriageFilter,
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivityTriageFilter,
	type AccountActivityViewFilter,
} from '#universal/account-activity-filters.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

const clampedCellCss = recordCellClamp(30)

export function AccountActivityPage({
	actorKey,
	pageQueryInput,
	currentHref,
}: {
	actorKey: string | null
	pageQueryInput: Parameters<typeof activityQuery>[1]
	currentHref: string
}) {
	const query = useSuspenseInfiniteQuery(
		activityQuery(actorKey, pageQueryInput),
	)
	const first = query.data.pages[0]!.payload
	const { selectedRun, summary, retentionDays } = first
	const seen = new Set<string>()
	const runs = query.data.pages
		.flatMap((page) => page.payload.runs)
		.filter((run) => {
			if (seen.has(run.id)) return false
			seen.add(run.id)
			return true
		})
	const nextCursor = query.hasNextPage
	const loadingMore = query.isFetchingNextPage
	const message = query.error?.message ?? null
	const router = useRouter()
	const navigate = (href: string) =>
		void router.navigate({ to: href, resetScroll: false })
	const replaceLocation = (href: string) =>
		void router.navigate({ to: href, replace: true, resetScroll: false })

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function getCurrentHref() {
		return currentHref
	}

	function loadMoreRuns() {
		if (!query.isFetching && query.hasNextPage) void query.fetchNextPage()
	}

	function updateFilters(input: {
		view?: AccountActivityViewFilter
		status?: AccountActivityStatusFilter
		surface?: AccountActivitySurfaceFilter
		triage?: AccountActivityTriageFilter
	}) {
		const href = getCurrentHref()
		const currentView = readViewFilter(href)
		const view = input.view ?? currentView
		const viewChanged = input.view != null && input.view !== currentView
		const search = buildActivitySearch({
			view,
			status:
				input.status ??
				(viewChanged
					? defaultAccountActivityStatusFilter(view)
					: readStatusFilter(href)),
			surface: input.surface ?? readSurfaceFilter(href),
			triage:
				input.triage ??
				(viewChanged
					? defaultAccountActivityTriageFilter(view)
					: readTriageFilter(href)),
		})
		if (selectedId) {
			navigate(activityRoute.buildDetailHref(selectedId, search, currentHref))
			return
		}
		replaceLocation(activityRoute.buildListHref(search, currentHref))
	}

	const selectedId = pageQueryInput.selectedRunId

	const viewFilter = readViewFilter(currentHref)
	const statusFilter = readStatusFilter(currentHref)
	const surfaceFilter = readSurfaceFilter(currentHref)
	const triageFilter = readTriageFilter(currentHref)
	const filterSearch = buildActivitySearch({
		view: viewFilter,
		status: statusFilter,
		surface: surfaceFilter,
		triage: triageFilter,
	})
	const detail =
		selectedRun && selectedRun.id === selectedId ? selectedRun : null
	const showRunNotFound = selectedId != null && !detail
	const emptyLabel = activityEmptyLabel({
		view: viewFilter,
		status: statusFilter,
		surface: surfaceFilter,
		triage: triageFilter,
		summaryTotal: summary?.total ?? 0,
	})

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="activity"
				title="Activity"
				description="Open failures first, plus a Recent runs week of jobs, executes, package apps, webhooks, and workflows — with the logs you need to diagnose them."
				currentHref={currentHref}
			/>
			<figure
				css={{
					display: 'grid',
					gap: spacing.sm,
					justifyItems: 'start',
					margin: 0,
					maxWidth: '46rem',
				}}
			>
				<blockquote
					css={{
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
						lineHeight: 1.5,
					}}
				>
					{activityErrorReviewPrompt}
				</blockquote>
				<CopyTextButton
					value={activityErrorReviewPrompt}
					idleLabel="Copy prompt"
					variant="ghost"
					size="sm"
				/>
			</figure>

			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}

			{summary ? (
				<>
					<div
						css={{
							display: 'grid',
							gap: spacing.md,
							gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
						}}
					>
						{[
							{ label: 'Runs (7 days)', value: String(summary.total) },
							{ label: 'Open errors', value: String(summary.errors) },
							{
								label: 'Ignored / resolved',
								value: String(summary.ignored + summary.resolved),
							},
							{ label: 'Running now', value: String(summary.running) },
						].map((item) => (
							<div
								key={item.label}
								css={{
									display: 'grid',
									gap: spacing.xs,
									padding: spacing.md,
									border: `1px solid ${colors.border}`,
									borderRadius: radius.md,
									backgroundColor: colors.surface,
								}}
							>
								<span
									css={{
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									}}
								>
									{item.label}
								</span>
								<strong
									css={{
										fontSize: typography.fontSize.xl,
										fontWeight: typography.fontWeight.semibold,
										color:
											item.label === 'Open errors' && summary.errors > 0
												? colors.error
												: colors.text,
									}}
								>
									{item.value}
								</strong>
							</div>
						))}
					</div>

					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						Ad-hoc execute runs are kept on success and on failure, the same as
						jobs and webhooks. Run records are kept for about {retentionDays}{' '}
						days. Open errors is the default view. Recent runs lists the last 7
						days across successes, running work, and errors. Ignored and
						resolved errors stay hidden from Open errors until you change the
						triage filter.
					</p>

					{showRunNotFound ? (
						<AccountManagementMessage tone="error">
							This run does not exist for this account, or it has aged out of
							the retention window.
						</AccountManagementMessage>
					) : null}

					<RecordTable
						mode="expand"
						ariaLabel="Activity runs"
						selectedId={selectedId}
						onNavigate={() => {}}
						emptyLabel={emptyLabel}
						toolbar={
							<>
								<RecordTableSelect
									label="Activity view"
									value={viewFilter}
									onChange={(rawValue) => {
										const value = rawValue as AccountActivityViewFilter
										if (
											!viewFilterOptions.some(
												(option) => option.value === value,
											)
										) {
											return
										}
										updateFilters({ view: value })
									}}
								>
									{viewFilterOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</RecordTableSelect>
								<RecordTableSelect
									label="Status filter"
									value={statusFilter}
									onChange={(rawValue) => {
										const value = rawValue as AccountActivityStatusFilter
										if (
											!statusFilterOptions.some(
												(option) => option.value === value,
											)
										) {
											return
										}
										updateFilters({ status: value })
									}}
								>
									{statusFilterOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</RecordTableSelect>
								<RecordTableSelect
									label="Surface filter"
									value={surfaceFilter}
									onChange={(rawValue) => {
										const value = rawValue as AccountActivitySurfaceFilter
										if (
											!surfaceFilterOptions.some(
												(option) => option.value === value,
											)
										) {
											return
										}
										updateFilters({ surface: value })
									}}
								>
									{surfaceFilterOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</RecordTableSelect>
								<RecordTableSelect
									label="Triage filter"
									value={triageFilter}
									onChange={(rawValue) => {
										const value = rawValue as AccountActivityTriageFilter
										if (
											!triageFilterOptions.some(
												(option) => option.value === value,
											)
										) {
											return
										}
										updateFilters({ triage: value })
									}}
								>
									{triageFilterOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</RecordTableSelect>
							</>
						}
						columns={[
							{ key: 'name', label: 'Run', primary: true },
							{ key: 'surface', label: 'Surface', drop: 3 },
							{ key: 'status', label: 'Status' },
							{ key: 'error', label: 'Error', drop: 1 },
							{ key: 'started', label: 'Started', drop: 2 },
							{ key: 'duration', label: 'Duration', align: 'end' },
						]}
						rows={runs.map((item) => {
							const attribution = runAttributionSubtitle(item)
							return {
								id: item.id,
								href: activityRoute.buildDetailHref(
									item.id,
									filterSearch,
									currentHref,
								),
								cells: {
									name: (
										<span
											css={{
												display: 'grid',
												gap: '0.125rem',
												minWidth: 0,
											}}
										>
											{renderWorkflowNameCell({
												name: runDisplayName(item),
												idempotencyKey: item.idempotencyKey,
											})}
											{attribution ? (
												<span css={recordStampCss}>{attribution}</span>
											) : null}
										</span>
									),
									surface: surfaceLabel(item.surface),
									status: (
										<span css={{ color: statusColor(item.status) }}>
											{statusLabel(item.status)}
										</span>
									),
									error: item.errorMessage ? (
										<span css={[clampedCellCss, { color: colors.error }]}>
											{item.errorMessage}
										</span>
									) : null,
									started: (
										<span css={recordStampCss}>
											{formatTimestamp(item.startedAt)}
										</span>
									),
									duration: (
										<span css={recordStampCss}>
											{formatDurationMs(item.durationMs)}
										</span>
									),
								},
							}
						})}
						footer={
							nextCursor ? (
								<button
									type="button"
									disabled={loadingMore}
									onClick={() => void loadMoreRuns()}
									css={{ ...secondaryButtonCss, width: '100%' }}
								>
									{loadingMore ? 'Loading more…' : 'Load more'}
								</button>
							) : null
						}
						record={detail ? renderActivityRunDetail(detail) : null}
					/>
				</>
			) : null}
		</AccountManagementShell>
	)
}

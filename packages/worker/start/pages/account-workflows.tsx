/** @jsxImportSource @emotion/react */
import { createListDetailLinks } from '#client/list-detail-route.ts'
import {
	filterAccountWorkflows,
	isActiveAccountWorkflow,
	type AccountWorkflowsViewFilter,
} from '#client/routes/account-workflows-filter.ts'
import { cancelWorkflowRun } from '#start/server/account-mutations'
import {
	type AccountWorkflowListItem,
	type AccountWorkflowRunStatus,
	type AccountWorkflowsLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	cardTitleCss,
	descriptionCss,
	getDangerPillCss,
	getGhostButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	useIsMutating,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { workflowCancellationMutationOptions } from '../workflow-cancellation-mutation.ts'
import { collectionSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordBodyCss,
	recordStampCss,
} from './record-table.tsx'
import {
	renderInlineWorkflowNameSubtitle,
	renderWorkflowNameCell,
} from './workflow-name-display.tsx'

type MessageTone = 'info' | 'error'

const workflowsRoute = createListDetailLinks('/account/workflows')

const viewFilterOptions: Array<{
	value: AccountWorkflowsViewFilter
	label: string
}> = [
	{ value: 'active', label: 'Active' },
	{ value: 'history', label: 'History' },
	{ value: 'all', label: 'All' },
]

/**
 * Latch key includes the selected workflow id because detail is loaded with
 * `?selected=`. Client-side `q` / `view` filters are omitted so search typing
 * and filter toggles do not refetch.
 */
function emptyWorkflowsMessage(input: {
	totalCount: number
	filteredCount: number
	view: AccountWorkflowsViewFilter
	search: string
}) {
	if (input.totalCount === 0) {
		return 'No workflow runs yet. Ask Kody to create a deferred or long-running run.'
	}
	if (input.filteredCount > 0) return null
	if (input.search || input.view === 'all') {
		return 'No workflows match the current filters.'
	}
	if (input.view === 'history') {
		return 'No finished workflow runs.'
	}
	return 'No active workflow runs. Switch to History or All to see other runs.'
}

function sourceLabel(workflow: Pick<AccountWorkflowListItem, 'sourceType'>) {
	switch (workflow.sourceType) {
		case 'inline':
			return 'Inline'
		case 'package':
			return 'Package'
		default: {
			const exhaustive: never = workflow.sourceType
			return exhaustive
		}
	}
}

function packageValue(
	username: string,
	workflow: Pick<AccountWorkflowListItem, 'sourceType' | 'kodyId'>,
) {
	if (workflow.sourceType !== 'package' || !workflow.kodyId || !username) {
		return '—'
	}
	return (
		<SiteLink
			href={routes.communityPackage.href({
				username,
				kodyId: workflow.kodyId,
			})}
			css={primaryLinkCss}
		>
			{workflow.kodyId}
		</SiteLink>
	)
}

function statusLabel(status: AccountWorkflowRunStatus | null) {
	if (status === null) return 'Creating'
	switch (status) {
		case 'queued':
			return 'Queued'
		case 'running':
			return 'Running'
		case 'paused':
			return 'Paused'
		case 'waiting':
			return 'Waiting'
		case 'waitingForPause':
			return 'Waiting for pause'
		case 'unknown':
			return 'Unknown'
		case 'complete':
			return 'Complete'
		case 'errored':
			return 'Errored'
		case 'terminated':
			return 'Terminated'
		case 'cancelled':
			return 'Cancelled'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

function statusColor(status: AccountWorkflowRunStatus | null) {
	if (status === null) return colors.textMuted
	switch (status) {
		case 'queued':
		case 'waiting':
		case 'waitingForPause':
		case 'paused':
		case 'unknown':
			return colors.textMuted
		case 'running':
			return colors.primary
		case 'complete':
			return colors.primary
		case 'errored':
		case 'terminated':
		case 'cancelled':
			return colors.error
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export function AccountWorkflowsPage({
	payload,
	currentHref,
	selectedId,
}: {
	payload: AccountWorkflowsLoaderData
	currentHref: string
	selectedId: string | null
}) {
	const { username, workflows, selectedWorkflow } = payload
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<MessageTone>('info')
	const [cancelArmed, setCancelArmed] = useState(false)
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const { orgSlug, pageLocation } = useMatchedPageScope()
	const mutationKey = ['workflows', actorKey, orgSlug] as const

	const isMutating = useIsMutating({ mutationKey }) > 0
	const router = useRouter()

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function getCurrentHref() {
		return currentHref
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function updateFilters(next: {
		search?: string
		view?: AccountWorkflowsViewFilter
	}) {
		const matchedUrl = new URL(currentHref, 'http://localhost')
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: matchedUrl.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				// Keep an in-flight search edit when a second filter changes.
				// Another page's pending search never belongs to this toolbar.
				const search: Record<string, unknown> = samePage
					? { ...previous }
					: { ...pageLocation.search }
				if (next.search !== undefined) {
					if (next.search) search.q = next.search
					else delete search.q
				}
				if (next.view !== undefined) {
					if (next.view === 'active') delete search.view
					else search.view = next.view
				}
				return search
			},
		})
	}

	function showMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		setMessage(nextMessage)
		setMessageTone(tone)
	}

	type ActionResult = {
		cancel?: {
			cancelled: boolean
			alreadyTerminal: boolean
			status: AccountWorkflowRunStatus | null
		}
	}
	const captureSubmitter = useSubmitterScope()
	const mutation = useMutation({
		retry: false,
		mutationKey,
		...workflowCancellationMutationOptions(
			queryClient,
			async (input: {
				id: string
				actorKey: string | null
				orgSlug: string | null
				failureMessage: string
			}) => {
				const id = input.id
				const orgSlug = input.orgSlug ?? undefined
				return cancelWorkflowRun({ data: { orgSlug, id } })
			},
		),
	})
	function postAction(input: {
		id: string
		successMessage: (payload: ActionResult) => string | null
		failureMessage: string
	}) {
		if (queryClient.isMutating({ mutationKey })) return
		const isCurrent = captureSubmitter()
		showMessage(null)
		setCancelArmed(false)
		mutation.mutate(
			{ ...input, actorKey, orgSlug },
			{
				onSuccess: (accepted) => {
					if (isCurrent()) showMessage(input.successMessage(accepted))
				},
				onError: (error) => {
					if (isCurrent()) showMessage(error.message, 'error')
				},
			},
		)
	}

	const filters = collectionSearch(pageLocation.search)
	const search = filters.q?.trim() ?? ''
	const view = filters.view
	const filteredWorkflows = filterAccountWorkflows(workflows, {
		view,
		search,
	})
	const listEmptyMessage = emptyWorkflowsMessage({
		totalCount: workflows.length,
		filteredCount: filteredWorkflows.length,
		view,
		search,
	})
	const detail =
		selectedWorkflow && selectedWorkflow.id === selectedId
			? selectedWorkflow
			: null
	const showWorkflowNotFound = selectedId != null && !detail
	const canCancel = detail ? isActiveAccountWorkflow(detail) : false

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="workflows"
				title="Workflows"
				description="Inspect deferred and long-running workflow runs — inline or package-backed — including status, schedule time, and errors. Cancel a run that has not finished yet."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage
					tone={messageTone === 'error' ? 'error' : 'info'}
				>
					{message}
				</AccountManagementMessage>
			) : null}

			<RecordTable
				mode="expand"
				ariaLabel="Workflow runs"
				selectedId={selectedId}
				onNavigate={() => {
					setCancelArmed(false)
					showMessage(null)
				}}
				countLabel={`${filteredWorkflows.length} of ${workflows.length} shown`}
				emptyLabel={
					listEmptyMessage ?? 'No workflows match the current filters.'
				}
				toolbar={
					<>
						<RecordTableSearch
							label="Search workflows"
							placeholder="Search workflows"
							value={filters.q ?? ''}
							onInput={(value) => {
								return updateFilters({ search: value })
							}}
						/>
						<RecordTableSelect
							label="Workflows view filter"
							value={view}
							onChange={(value) => {
								if (
									value !== 'active' &&
									value !== 'history' &&
									value !== 'all'
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
					</>
				}
				columns={[
					{ key: 'name', label: 'Workflow', primary: true },
					{ key: 'source', label: 'Source', drop: 2 },
					{ key: 'status', label: 'Status' },
					{ key: 'runAt', label: 'Run at', drop: 1 },
					{ key: 'updated', label: 'Updated', drop: 3 },
				]}
				rows={filteredWorkflows.map((item) => ({
					id: item.id,
					href: isMutating
						? undefined
						: workflowsRoute.buildDetailHref(
								item.id,
								getCurrentSearch(),
								currentHref,
							),
					cells: {
						name: renderWorkflowNameCell({
							name: item.workflowName,
							idempotencyKey: item.idempotencyKey,
						}),
						source: sourceLabel(item),
						status: (
							<span css={{ color: statusColor(item.status) }}>
								{statusLabel(item.status)}
							</span>
						),
						runAt: (
							<span css={recordStampCss}>
								<TimestampValue value={item.runAt} />
							</span>
						),
						updated: (
							<span css={recordStampCss}>
								<TimestampValue value={item.updatedAt} />
							</span>
						),
					},
				}))}
				record={
					detail ? (
						<section css={recordBodyCss}>
							<div css={{ display: 'grid', gap: spacing.xs }}>
								<h2 css={cardTitleCss}>{detail.workflowName}</h2>
								{renderInlineWorkflowNameSubtitle({
									displayedName: detail.workflowName,
									idempotencyKey: detail.idempotencyKey,
								})}
								<p css={descriptionCss}>
									{detail.sourceType === 'package'
										? 'Package workflow run. Cancel stops the underlying Cloudflare Workflow instance when it has not finished yet.'
										: 'Inline workflow run. Cancel stops the underlying Cloudflare Workflow instance when it has not finished yet.'}
								</p>
							</div>

							<MetadataGrid
								items={[
									{
										label: 'Status',
										value: (
											<span css={{ color: statusColor(detail.status) }}>
												{statusLabel(detail.status)}
											</span>
										),
									},
									{
										label: 'Source',
										value: sourceLabel(detail),
									},
									{
										label: 'Package',
										value: packageValue(username, detail),
									},
									{
										label: 'Export',
										value: detail.exportName ?? '—',
									},
									{
										label: 'Run at',
										value: <TimestampValue value={detail.runAt} />,
									},
									{
										label: 'Plan date',
										value: detail.planDate ?? '—',
									},
									{
										label: 'Created',
										value: <TimestampValue value={detail.createdAt} />,
									},
									{
										label: 'Updated',
										value: <TimestampValue value={detail.updatedAt} />,
									},
									{
										label: 'Completed',
										value: <TimestampValue value={detail.completedAt} />,
									},
									{
										label: 'Idempotency key',
										value: (
											<IdValue
												value={detail.idempotencyKey}
												label="idempotency key"
											/>
										),
									},
									{
										label: 'Workflow id',
										value: <IdValue value={detail.id} label="workflow id" />,
									},
									{
										label: 'Kody id',
										value: detail.kodyId ? (
											<IdValue value={detail.kodyId} label="kody id" />
										) : (
											'—'
										),
									},
									{
										label: 'Source id',
										value: detail.sourceId ? (
											<IdValue value={detail.sourceId} label="source id" />
										) : (
											'—'
										),
									},
								]}
							/>

							{detail.lastError ? (
								<AccountManagementMessage tone="error">
									{detail.lastError}
								</AccountManagementMessage>
							) : null}

							{canCancel ? (
								<div
									css={{
										display: 'flex',
										gap: spacing.sm,
										flexWrap: 'wrap',
									}}
								>
									<button
										type="button"
										disabled={isMutating}
										css={dangerButtonCss}
										onBlur={() => setCancelArmed(false)}
										onClick={() => {
											if (!cancelArmed) {
												setCancelArmed(true)
												return
											}
											void postAction({
												id: detail.id,
												successMessage: (payload) =>
													payload.cancel?.alreadyTerminal
														? `Workflow already finished with status "${statusLabel(payload.cancel.status)}".`
														: 'Cancelled workflow run.',
												failureMessage: 'Unable to cancel workflow run.',
											})
										}}
									>
										{cancelArmed ? 'Confirm cancel' : 'Cancel run'}
									</button>
									{cancelArmed ? (
										<button
											type="button"
											disabled={isMutating}
											onClick={() => {
												setCancelArmed(false)
											}}
											css={secondaryButtonCss}
										>
											Keep running
										</button>
									) : null}
								</div>
							) : null}
						</section>
					) : showWorkflowNotFound ? (
						<div css={{ ...recordBodyCss, gap: spacing.sm }}>
							<h2
								css={{
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								Workflow not found
							</h2>
							<p css={{ margin: 0, color: colors.textMuted }}>
								This workflow run does not exist for this account or is
								unavailable.
							</p>
						</div>
					) : null
				}
			/>
		</AccountManagementShell>
	)
}

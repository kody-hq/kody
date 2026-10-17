/** @jsxImportSource @emotion/react */
import {
	filterAccountJobs,
	type AccountJobsViewFilter,
} from '#client/routes/account-jobs-filter.ts'
import { setJobKillSwitch, runJobNow } from '#start/server/account-mutations'
import {
	type AccountJobListItem,
	type AccountJobsLoaderData,
} from '#universal/loader-data.ts'
import {
	useIsMutating,
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { collectionSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	renderAccountJobDetail,
	renderJobDetailPlaceholder,
} from './account-jobs-detail.tsx'
import {
	settleAccountMutation,
	jobResources,
} from './account-mutation-settlement.ts'
import {
	emptyJobsMessage,
	jobsRoute,
	packageLabel,
	statusColor,
	statusLabel,
	viewFilterOptions,
	type AccountJobsActionPayload,
} from './account-jobs-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import {
	RecordChips,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
} from './record-table.tsx'

const clampedCellCss = recordCellClamp(28)

type MessageTone = 'info' | 'error'

export function AccountJobsPage({
	payload: savedPayload,
	currentHref,
	selectedId,
}: {
	payload: AccountJobsLoaderData
	currentHref: string
	selectedId: string | null
}) {
	const { actorKey, orgSlug, pageLocation } = useMatchedPageScope()
	const mutationKey = ['jobs', actorKey, orgSlug] as const
	const changes = useMutationState({
		filters: { mutationKey, status: 'pending' },
		select: (mutation) =>
			mutation.state.variables as
				| { id: string; killSwitchEnabled?: boolean }
				| undefined,
	})
	const payload = changes.reduce(
		(data, input) =>
			input && typeof input.killSwitchEnabled === 'boolean'
				? optimisticJobs(data, {
						id: input.id,
						killSwitchEnabled: input.killSwitchEnabled,
					})
				: data,
		savedPayload,
	)
	const { username, jobs, selectedJob } = payload

	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<MessageTone>('info')
	const router = useRouter()
	const navigate = (href: string) =>
		void router.navigate({ to: href, resetScroll: false })

	function getCurrentHref() {
		return currentHref
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function updateFilters(next: {
		search?: string
		view?: AccountJobsViewFilter
	}) {
		const matchedUrl = new URL(currentHref, 'http://localhost')
		// Compose consecutive filter edits from Router's latest search, even
		// before the previous navigation commits. Pin the destination to this
		// rendered page so a retained toolbar cannot edit a different page.
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: matchedUrl.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
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

	const queryClient = useQueryClient()
	const isMutating = useIsMutating({ mutationKey }) > 0

	const captureSubmitter = useSubmitterScope()
	const reconcile = (
		input: { orgSlug: string | null },
		submitted: { actorKey: string | null },
	) =>
		settleAccountMutation(queryClient, submitted.actorKey, jobResources, {
			orgSlug: input.orgSlug,
		})

	const runMutation = useMutation({
		mutationKey,
		retry: false,
		mutationFn: (input: { id: string; orgSlug: string | null }) =>
			runJobNow({ data: { ...input, orgSlug: input.orgSlug ?? undefined } }),
		onMutate: () => ({ actorKey }),
		onSettled: (_data, _error, input, submitted) =>
			submitted ? reconcile(input, submitted) : undefined,
	})
	const killMutation = useMutation({
		mutationKey,
		retry: false,
		mutationFn: (input: {
			id: string
			killSwitchEnabled: boolean
			orgSlug: string | null
		}) =>
			setJobKillSwitch({
				data: { ...input, orgSlug: input.orgSlug ?? undefined },
			}),
		onMutate: () => ({ actorKey }),
		onSettled: (_data, _error, input, submitted) =>
			submitted ? reconcile(input, submitted) : undefined,
	})
	async function postAction(input: {
		write: () => Promise<AccountJobsActionPayload>
		successMessage: (payload: AccountJobsActionPayload) => string | null
		failureMessage: string
		afterSuccess?: (payload: AccountJobsActionPayload) => void
	}) {
		if (queryClient.isMutating({ mutationKey })) return
		const isCurrent = captureSubmitter()
		showMessage(null)
		try {
			const accepted = await input.write()
			if (!isCurrent()) return
			showMessage(input.successMessage(accepted))
			input.afterSuccess?.(accepted)
		} catch (error) {
			if (isCurrent())
				showMessage(
					error instanceof Error ? error.message : input.failureMessage,
					'error',
				)
		}
	}

	const filters = collectionSearch(pageLocation.search)
	const search = filters.q?.trim() ?? ''
	const view = filters.view
	const filteredJobs = filterAccountJobs(jobs, {
		view,
		search,
	})
	const listEmptyMessage = emptyJobsMessage({
		totalCount: jobs.length,
		filteredCount: filteredJobs.length,
		view,
		search,
	})
	const detail =
		selectedJob && selectedJob.id === selectedId ? selectedJob : null
	const showJobNotFound = selectedId != null && !detail

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="jobs"
				title="Jobs"
				description="Inspect scheduled package jobs, toggle the kill switch, and run jobs now. To change or remove a job, edit its package and publish."
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
				ariaLabel="Scheduled jobs"
				selectedId={selectedId}
				onNavigate={() => {
					showMessage(null)
				}}
				countLabel={`${filteredJobs.length} of ${jobs.length} shown`}
				emptyLabel={listEmptyMessage ?? 'No jobs match the current filters.'}
				toolbar={
					<>
						<RecordTableSearch
							label="Search jobs"
							placeholder="Search jobs"
							value={filters.q ?? ''}
							onInput={(value) => {
								return updateFilters({ search: value })
							}}
						/>
						<RecordTableSelect
							label="Jobs view filter"
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
					{ key: 'name', label: 'Job', primary: true },
					{ key: 'status', label: 'Status' },
					{ key: 'schedule', label: 'Schedule', drop: 1 },
					{ key: 'package', label: 'Package', drop: 2 },
					{ key: 'flags', label: 'Flags', drop: 3 },
					{ key: 'runs', label: 'Runs', align: 'end' },
				]}
				rows={filteredJobs.map((item) => ({
					id: item.id,
					// A save, toggle, or delete is in flight; the expanded
					// editor owns the selection until it settles.
					href: isMutating
						? undefined
						: jobsRoute.buildDetailHref(
								item.id,
								getCurrentSearch(),
								currentHref,
							),
					cells: {
						name: <span css={clampedCellCss}>{item.name}</span>,
						status: (
							<span css={{ color: statusColor(item) }}>
								{statusLabel(item)}
							</span>
						),
						schedule: <span css={clampedCellCss}>{item.scheduleSummary}</span>,
						package: <span css={clampedCellCss}>{packageLabel(item)}</span>,
						flags: (
							<RecordChips items={item.expired ? ['Expired'] : []} empty="—" />
						),
						runs: String(item.runCount),
					},
				}))}
				record={
					detail
						? renderAccountJobDetail({
								username,
								currentHref,
								detail,
								isMutating,
								runJobAction: (input) =>
									postAction({
										...input,
										write: () =>
											runMutation.mutateAsync({ id: input.id, orgSlug }),
									}),
								setKillSwitchAction: (input) =>
									postAction({
										...input,
										write: () =>
											killMutation.mutateAsync({
												id: input.id,
												killSwitchEnabled: input.killSwitchEnabled,
												orgSlug,
											}),
									}),
								navigateToList: () => {
									navigate(
										jobsRoute.buildListHref(getCurrentSearch(), currentHref),
									)
								},
							})
						: showJobNotFound
							? renderJobDetailPlaceholder(
									'Job not found',
									'This job does not exist for this account or is unavailable.',
								)
							: null
				}
			/>
		</AccountManagementShell>
	)
}

function optimisticJobs(
	data: AccountJobsLoaderData,
	body: { id: string; killSwitchEnabled: boolean },
): AccountJobsLoaderData {
	const update = <T extends AccountJobListItem>(job: T): T => {
		if (job.id !== body.id) return job
		return { ...job, killSwitchEnabled: body.killSwitchEnabled }
	}
	return {
		...data,
		jobs: data.jobs.map(update),
		selectedJob: data.selectedJob && update(data.selectedJob),
	}
}

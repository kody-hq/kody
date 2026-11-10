/** @jsxImportSource @emotion/react */
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type FormEvent,
	type MouseEvent,
} from 'react'
import { useMachine } from '@xstate/react'
import {
	adminCodemodRunState,
	type AdminCodemodRunState,
} from '#client/routes/admin-codemod-run-state.ts'
import type { AdminCodemodRunInput } from '#universal/admin-codemod-input.ts'
import {
	formatSummaryCounts,
	maxRunSteps,
	mergeSummaryCounts,
	parseCommaSeparatedIds,
	runModes,
	type RunPhase,
	type RunMode,
} from '#client/routes/admin-codemods-shared.ts'
import { readAdminCodemodItems } from '#start/server/admin-controls'
import {
	adminCodemodRun,
	adminCodemodRunStop,
} from '#start/server/admin-mutations'
import type {
	AdminCodemodRunItemListItem,
	AdminCodemodRunListItem,
	AdminCodemodsLoaderData,
} from '#universal/loader-data.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import {
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import {
	renderCodemodItemsTable,
	renderRegisteredCodemodsPanel,
	RunHistoryPanel,
} from './admin-codemods-sections.tsx'
const selectCss = getSelectCss()
export function AdminCodemodsPage(props: {
	payload: AdminCodemodsLoaderData
	currentHref: string
}) {
	const { codemods, runs } = props.payload
	const invalidatePages = usePageInvalidation(mutationResources)
	const lifetime = useRef<AbortController | null>(null)
	useEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		return () => {
			controller.abort()
		}
	}, [])
	const [runSnapshot, , runActor] = useMachine(adminCodemodRunState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return adminCodemodRunState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	})
	const run = uiState<AdminCodemodRunState>(runSnapshot)
	const transitionRun = useCallback(
		(event: Parameters<typeof runActor.send>[0]) =>
			sendUiEvent(runActor, event),
		[runActor],
	)
	const getRun = useCallback(
		() => uiState<AdminCodemodRunState>(runActor.getSnapshot()),
		[runActor],
	)
	const [feedback, setFeedback] = useState<{
		tone: 'info' | 'error'
		message: string
	} | null>(null)
	const message = feedback?.message ?? ('message' in run ? run.message : null)
	const messageTone =
		feedback?.tone ?? (run.status === 'error' ? 'error' : 'info')
	const runPhase: RunPhase = run.status === 'stopping' ? 'running' : run.status
	const stopRequested = run.status === 'stopping'
	const liveRunId = 'runId' in run ? run.runId : null
	const liveItems = 'items' in run ? run.items : []
	const liveSummary = 'summary' in run ? run.summary : {}
	const [selectedCodemodId, setSelectedCodemodId] = useState(
		props.payload.codemods[0]?.id ?? '',
	)
	const [selectedMode, setSelectedMode] = useState<RunMode>('scan')
	const [userIdsFilter, setUserIdsFilter] = useState('')
	const [packageIdsFilter, setPackageIdsFilter] = useState('')
	const [enforcementOnly, setEnforcementOnly] = useState(false)
	const [revertOfRunId, setRevertOfRunId] = useState('')
	const [pendingConfirmKey, setPendingConfirmKey] = useState<string | null>(
		null,
	)
	const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<
		string | null
	>(null)
	const [historyItems, setHistoryItems] = useState<
		Array<AdminCodemodRunItemListItem>
	>([])
	const [historyRun, setHistoryRun] = useState<AdminCodemodRunListItem | null>(
		null,
	)
	const [historyLoading, setHistoryLoading] = useState(false)
	const [historyNextAfterId, setHistoryNextAfterId] = useState<string | null>(
		null,
	)
	const historyRequestIdRef = useRef(0)
	function requestStop() {
		const current = getRun()
		if (current.status === 'running')
			transitionRun({
				type: 'STOP',
				data: uiContext({ ...current, status: 'stopping' }).data,
			} as Parameters<typeof runActor.send>[0])
	}
	async function refreshRuns() {
		// The subscribed loader owns this payload. A separate JSON GET followed
		// by invalidation would read the same run list twice.
		await invalidatePages()
	}
	async function loadHistoryRun(runId: string, append = false) {
		const requestId = ++historyRequestIdRef.current
		setHistoryLoading(true)
		if (!append) {
			setSelectedHistoryRunId(runId)
			setHistoryItems([])
			setHistoryRun(null)
			setHistoryNextAfterId(null)
		}
		try {
			const payload = await readAdminCodemodItems({
				data: { runId, afterId: append ? historyNextAfterId : null },
			})
			if (requestId !== historyRequestIdRef.current) return
			setHistoryRun(payload.run)
			setHistoryItems(
				append ? [...historyItems, ...payload.items] : payload.items,
			)
			setHistoryNextAfterId(payload.nextAfterId)
		} catch (error) {
			if (requestId !== historyRequestIdRef.current) return
			setFeedback({
				tone: 'error',
				message:
					error instanceof Error ? error.message : 'Unable to load run items.',
			})
		} finally {
			if (requestId === historyRequestIdRef.current) {
				setHistoryLoading(false)
			}
		}
	}
	function buildRunBody(input: {
		runId?: string
		cursor?: string | null
		revertOfRunId?: string
		mode: RunMode
		codemodId: string
	}) {
		const userIds = parseCommaSeparatedIds(userIdsFilter)
		const packageIds = parseCommaSeparatedIds(packageIdsFilter)
		const body: AdminCodemodRunInput = {
			codemodId: input.codemodId,
			mode: input.mode,
			scope: 'fleet',
		}
		if (userIds.length > 0 || packageIds.length > 0 || enforcementOnly) {
			body.filters = {
				...(enforcementOnly
					? { scope: 'credential-need-enforcement' as const }
					: {}),
				...(userIds.length > 0 ? { userIds } : {}),
				...(packageIds.length > 0 ? { packageIds } : {}),
			}
		}
		if (input.runId) body.runId = input.runId
		if (input.cursor !== undefined) body.cursor = input.cursor
		if (input.mode === 'revert') {
			body.revertOfRunId = input.revertOfRunId
		}
		return body
	}
	// Best-effort: without this, a run whose paging loop stops client-side
	// (stop button, step ceiling, stuck cursor) stays `running` in the ledger
	// forever. Server-side stale reconciliation is the fallback.
	async function markRunStopped(runId: string) {
		try {
			await adminCodemodRunStop({ data: { runId } })
		} catch {
			// The stale-run sweep on the next history load covers this.
		}
	}
	async function postRunStep(body: AdminCodemodRunInput) {
		const payload = await adminCodemodRun({ data: body })
		return payload
	}
	async function runPagedCodemod(input: {
		mode: RunMode
		codemodId: string
		revertOfRunId?: string
	}) {
		const current = getRun()
		if (current.status === 'running' || current.status === 'stopping') return
		if (
			!transitionRun({
				type: 'SUBMIT',
				data: uiContext({
					status: 'running',
					runId: null,
					items: [],
					summary: {},
				}).data,
			} as Parameters<typeof runActor.send>[0])
		)
			return
		setFeedback(null)
		setPendingConfirmKey(null)
		let runId: string | undefined
		let cursor: string | null | undefined
		let stepCount = 0
		async function finish(status: 'complete' | 'error', message: string) {
			await refreshRuns()
			if (lifetime.current?.signal.aborted) return
			const current = getRun()
			if (current.status !== 'running' && current.status !== 'stopping') return
			setFeedback(null)
			transitionRun({
				type: status === 'complete' ? 'RESPONSE_OK' : 'RESPONSE_ERROR',
				data: { ...uiContext(current).data, message },
			} as Parameters<typeof runActor.send>[0])
		}
		try {
			for (;;) {
				if (
					getRun().status === 'stopping' ||
					lifetime.current?.signal.aborted
				) {
					if (runId) await markRunStopped(runId)
					await finish(
						'complete',
						`Stopped ${input.mode} for ${input.codemodId}${runId ? ` (run ${runId})` : ''} after ${stepCount} step(s).`,
					)
					return
				}
				if (stepCount >= maxRunSteps) {
					if (runId) await markRunStopped(runId)
					await finish(
						'error',
						`Stopped after ${maxRunSteps} steps without completing. Resume later with the same run id if needed.`,
					)
					return
				}
				const previousCursor = cursor
				const step = await postRunStep(
					buildRunBody({
						runId,
						cursor,
						mode: input.mode,
						codemodId: input.codemodId,
						revertOfRunId: input.revertOfRunId,
					}),
				)
				if (!step) return
				if (lifetime.current?.signal.aborted) {
					if (step.runId) await markRunStopped(step.runId)
					return
				}
				stepCount += 1
				runId = step.runId
				const current = getRun()
				if (current.status !== 'running' && current.status !== 'stopping')
					return
				transitionRun({
					type: 'PROGRESS',
					data: uiContext({
						...current,
						runId: step.runId ?? null,
						items: [
							...current.items,
							...(step.items ?? []).map((item) => ({
								itemId: item.itemId,
								userId: item.userId,
								packageId: item.packageId,
								kodyId: item.kodyId,
								status: item.status,
								changedPaths: item.changedPaths ?? [],
								findings: item.findings ?? [],
								error: item.error ?? null,
							})),
						],
						summary: step.summary
							? mergeSummaryCounts(current.summary, step.summary)
							: current.summary,
					}).data,
				} as Parameters<typeof runActor.send>[0])
				if (step.nextCursor == null) break
				if (
					previousCursor !== undefined &&
					previousCursor === step.nextCursor
				) {
					if (runId) await markRunStopped(runId)
					await finish(
						'error',
						`Codemod run stopped: cursor did not advance (${step.nextCursor}).`,
					)
					return
				}
				cursor = step.nextCursor
			}
			await finish(
				'complete',
				`Finished ${input.mode} for ${input.codemodId}${runId ? ` (run ${runId})` : ''}.`,
			)
		} catch (error) {
			const current = getRun()
			if (
				!lifetime.current?.signal.aborted &&
				(current.status === 'running' || current.status === 'stopping')
			) {
				setFeedback(null)
				transitionRun({
					type: 'RESPONSE_ERROR',
					data: uiContext({
						...current,
						status: 'error',
						message:
							error instanceof Error
								? error.message
								: 'Unable to complete package codemod run.',
					}).data,
				} as Parameters<typeof runActor.send>[0])
			}
		}
	}
	function getConfirmKey(action: string, id: string) {
		return `${action}:${id}`
	}
	function getDestructiveButtonProps(
		action: string,
		id: string,
		onConfirm: () => void,
	) {
		const key = getConfirmKey(action, id)
		return {
			onBlur: () => {
				if (pendingConfirmKey === key) setPendingConfirmKey(null)
			},
			onClick: (event: MouseEvent<HTMLButtonElement>) => {
				if (pendingConfirmKey !== key) {
					event.preventDefault()
					setPendingConfirmKey(key)
					return
				}
				setPendingConfirmKey(null)
				onConfirm()
			},
		}
	}
	function handleRunSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		if (!selectedCodemodId) {
			setFeedback({ tone: 'error', message: 'Select a codemod first.' })
			return
		}
		if (selectedMode === 'apply' || selectedMode === 'revert') {
			setFeedback({
				tone: 'info',
				message: `Use the ${selectedMode} button and confirm to start a destructive run.`,
			})
			return
		}
		void runPagedCodemod({
			mode: selectedMode,
			codemodId: selectedCodemodId,
		})
	}
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const currentHref = props.currentHref
	const pending = false
	const status: string = 'ready'
	const isRunning = runPhase === 'running'
	const canMutate = !isRunning && status === 'ready'
	const applyConfirmActive =
		pendingConfirmKey === getConfirmKey('apply', selectedCodemodId)
	const revertFormConfirmActive =
		pendingConfirmKey === getConfirmKey('revert-form', selectedCodemodId)
	return (
		<AccountManagementShell
			layout="list"
			currentHref={currentHref}
			busy={pending}
		>
			<AdminPageHeader
				title="Admin codemods"
				description="Scan, dry-run, apply, and revert package codemods across the fleet."
				currentHref={currentHref}
			/>
			{status === 'loading' ? (
				<LoadingIndicator label="Loading package codemods…" />
			) : null}
			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			<div css={{ display: 'grid', gap: spacing.lg }}>
				{renderRegisteredCodemodsPanel(codemods)}

				<AccountManagementPanel
					title="Run codemod"
					description="Each click walks the fleet as one HTTP request per page until nextCursor is null (stop anytime; hard ceiling 200 steps). Apply and revert require an explicit scope and confirmation."
				>
					<form
						aria-busy={isRunning}
						method="post"
						onSubmit={handleRunSubmit}
						css={{
							display: 'grid',
							gap: spacing.md,
						}}
					>
						<div
							css={{
								display: 'grid',
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
								gap: spacing.md,
								[mq.mobile]: {
									gridTemplateColumns: 'minmax(0, 1fr)',
								},
							}}
						>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Codemod</span>
								<select
									data-field-ring
									name="codemodId"
									value={selectedCodemodId}
									disabled={!canMutate}
									onChange={(event) => {
										if (!(event.currentTarget instanceof HTMLSelectElement))
											return
										setSelectedCodemodId(event.currentTarget.value)
									}}
									css={selectCss}
								>
									{codemods.map((codemod) => (
										<option key={codemod.id} value={codemod.id}>
											{codemod.id}
										</option>
									))}
								</select>
							</label>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Mode</span>
								<select
									data-field-ring
									name="mode"
									value={selectedMode}
									disabled={!canMutate}
									onChange={(event) => {
										if (!(event.currentTarget instanceof HTMLSelectElement))
											return
										const next = event.currentTarget.value
										for (const mode of runModes) {
											if (mode === next) {
												setSelectedMode(mode)
												return
											}
										}
									}}
									css={selectCss}
								>
									{runModes.map((mode) => (
										<option key={mode} value={mode}>
											{mode}
										</option>
									))}
								</select>
							</label>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>User IDs filter</span>
								<input
									data-field-ring
									name="userIds"
									type="text"
									placeholder="comma-separated stable user ids"
									value={userIdsFilter}
									disabled={!canMutate}
									onInput={(event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setUserIdsFilter(event.currentTarget.value)
									}}
									css={accountInputCss}
								/>
							</label>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Package IDs filter</span>
								<input
									data-field-ring
									name="packageIds"
									type="text"
									placeholder="comma-separated package ids"
									value={packageIdsFilter}
									disabled={!canMutate}
									onInput={(event) => {
										if (!(event.currentTarget instanceof HTMLInputElement))
											return
										setPackageIdsFilter(event.currentTarget.value)
									}}
									css={accountInputCss}
								/>
							</label>
							<label css={fieldCss}>
								<span css={fieldLabelCss}>Credential enforcement scope</span>
								<select
									value={enforcementOnly ? 'enforcement' : 'all'}
									disabled={!canMutate || selectedMode === 'revert'}
									css={selectCss}
									onChange={(event) => {
										setEnforcementOnly(
											event.currentTarget.value === 'enforcement',
										)
										setPendingConfirmKey(null)
									}}
								>
									<option value="all">All matching packages</option>
									<option value="enforcement">
										Packages subject to credential-need enforcement
									</option>
								</select>
							</label>
							{selectedMode === 'revert' ? (
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Revert of run ID</span>
									<input
										data-field-ring
										name="revertOfRunId"
										type="text"
										required
										placeholder="prior apply run id"
										value={revertOfRunId}
										disabled={!canMutate}
										onInput={(event) => {
											if (!(event.currentTarget instanceof HTMLInputElement))
												return
											setRevertOfRunId(event.currentTarget.value)
										}}
										css={accountInputCss}
									/>
								</label>
							) : null}
						</div>
						<div
							css={{
								display: 'flex',
								gap: spacing.sm,
								flexWrap: 'wrap',
								alignItems: 'center',
							}}
						>
							{selectedMode === 'apply' ? (
								<button
									type="button"
									disabled={!canMutate || !selectedCodemodId}
									{...{
										onBlur: () => {
											if (
												pendingConfirmKey ===
												getConfirmKey('apply', selectedCodemodId)
											)
												setPendingConfirmKey(null)
										},
										onClick: (event: MouseEvent<HTMLButtonElement>) => {
											if (
												pendingConfirmKey !==
												getConfirmKey('apply', selectedCodemodId)
											) {
												event.preventDefault()
												setPendingConfirmKey(
													getConfirmKey('apply', selectedCodemodId),
												)
												return
											}
											setPendingConfirmKey(null)
											;(() => {
												void runPagedCodemod({
													mode: 'apply',
													codemodId: selectedCodemodId,
												})
											})()
										},
									}}
									css={dangerButtonCss}
								>
									{isRunning
										? 'Running…'
										: applyConfirmActive
											? 'Confirm apply'
											: 'Apply'}
								</button>
							) : selectedMode === 'revert' ? (
								<button
									type="button"
									disabled={
										!canMutate || !selectedCodemodId || !revertOfRunId.trim()
									}
									{...{
										onBlur: () => {
											if (
												pendingConfirmKey ===
												getConfirmKey('revert-form', selectedCodemodId)
											)
												setPendingConfirmKey(null)
										},
										onClick: (event: MouseEvent<HTMLButtonElement>) => {
											if (
												pendingConfirmKey !==
												getConfirmKey('revert-form', selectedCodemodId)
											) {
												event.preventDefault()
												setPendingConfirmKey(
													getConfirmKey('revert-form', selectedCodemodId),
												)
												return
											}
											setPendingConfirmKey(null)
											;(() => {
												void runPagedCodemod({
													mode: 'revert',
													codemodId: selectedCodemodId,
													revertOfRunId: revertOfRunId.trim(),
												})
											})()
										},
									}}
									css={dangerButtonCss}
								>
									{isRunning
										? 'Running…'
										: revertFormConfirmActive
											? 'Confirm revert'
											: 'Revert'}
								</button>
							) : (
								<button
									type="submit"
									disabled={!canMutate || !selectedCodemodId}
									css={primaryButtonCss}
								>
									{isRunning ? 'Running…' : 'Run'}
								</button>
							)}
							{isRunning ? (
								<button
									type="button"
									disabled={stopRequested}
									onClick={() => {
										requestStop()
									}}
									css={secondaryButtonCss}
								>
									{stopRequested ? 'Stopping…' : 'Stop'}
								</button>
							) : null}
							{liveRunId ? (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Run {liveRunId} · {formatSummaryCounts(liveSummary)}
								</p>
							) : null}
						</div>
					</form>
				</AccountManagementPanel>

				{liveItems.length > 0 || runPhase !== 'idle' ? (
					<AccountManagementPanel
						title="Live results"
						description={formatSummaryCounts(liveSummary)}
					>
						{renderCodemodItemsTable({
							ariaLabel: 'Live codemod results',
							emptyLabel: isRunning
								? 'Waiting for the first page…'
								: 'No items.',
							items: liveItems.map((item) => ({
								id: item.itemId,
								kodyId: item.kodyId,
								userId: item.userId,
								status: item.status,
								changedPaths: item.changedPaths,
								findings: item.findings,
								error: item.error,
							})),
						})}
					</AccountManagementPanel>
				) : null}

				{
					<RunHistoryPanel
						{...{
							runs,
							selectedHistoryRunId,
							historyRun,
							historyItems,
							historyLoading,
							historyNextAfterId,
							canMutate,
							isRevertConfirmActive: (runId) =>
								pendingConfirmKey === getConfirmKey('revert-history', runId),
							getDestructiveButtonProps,
							onShowDetails: (runId) => {
								void loadHistoryRun(runId)
							},
							onLoadMore: () => {
								if (!selectedHistoryRunId) return
								void loadHistoryRun(selectedHistoryRunId, true)
							},
							onRevert: (run) => {
								setSelectedCodemodId(run.codemodId)
								setSelectedMode('revert')
								setRevertOfRunId(run.id)
								void runPagedCodemod({
									mode: 'revert',
									codemodId: run.codemodId,
									revertOfRunId: run.id,
								})
							},
						}}
					/>
				}
			</div>
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadAdminCodemods',
	'loadPackage',
	'loadPackageFiles',
	'loadProfile',
	'loadCommunity',
] as const

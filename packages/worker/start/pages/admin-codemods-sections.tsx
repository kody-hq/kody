/** @jsxImportSource @emotion/react */
import { formatFindings } from '#client/routes/admin-codemods-shared.ts'
import {
	type AdminCodemodListItem,
	type AdminCodemodRunItemListItem,
	type AdminCodemodRunListItem,
} from '#universal/loader-data.ts'
import {
	descriptionCss,
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { css } from '@emotion/react'
import { type ButtonHTMLAttributes } from 'react'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import { AccountManagementPanel } from './account-management-components.tsx'
import {
	RecordTable,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
	type RecordTableColumn,
} from './record-table.tsx'
/**
 * The live run and the history drill-down list the same item shape, so they
 * share one column set.
 */
const codemodItemColumns: Array<RecordTableColumn> = [
	{ key: 'kodyId', label: 'kodyId', primary: true },
	{ key: 'userId', label: 'userId', drop: 2 },
	{ key: 'status', label: 'status' },
	{ key: 'changedPaths', label: 'changedPaths', drop: 1 },
	{ key: 'findings', label: 'findings', drop: 3 },
	{ key: 'error', label: 'error' },
]
const clampedCellCss = css(recordCellClamp(24))
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })
type CodemodItemDisplay = {
	id: string
	kodyId: string
	userId: string
	status: string
	changedPaths: Array<string>
	findings: Array<{
		path: string | null
		message: string
	}>
	error: string | null
}
type DestructiveButtonProps = (
	action: string,
	id: string,
	onConfirm: () => void,
) => Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onBlur' | 'onClick'>
export function renderCodemodItemsTable(input: {
	ariaLabel: string
	emptyLabel?: string
	items: Array<CodemodItemDisplay>
}) {
	return (
		<RecordTable
			mode="none"
			ariaLabel={input.ariaLabel}
			scrollHeight="28rem"
			emptyLabel={input.emptyLabel ?? 'No items.'}
			columns={codemodItemColumns}
			rows={input.items.map((item) => ({
				id: item.id,
				cells: {
					kodyId: item.kodyId,
					userId: <span css={clampedCellCss}>{item.userId}</span>,
					status: item.status,
					changedPaths: (
						<span css={clampedCellCss}>
							{item.changedPaths.join(', ') || '—'}
						</span>
					),
					findings: formatFindings(item.findings),
					error: <span css={clampedCellCss}>{item.error ?? '—'}</span>,
				},
			}))}
		/>
	)
}
export function renderRegisteredCodemodsPanel(
	codemods: Array<AdminCodemodListItem>,
) {
	return (
		<AccountManagementPanel
			title="Registered codemods"
			description="Transforms available to the package codemod engine."
		>
			{codemods.length === 0 ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					No package codemods are registered.
				</p>
			) : (
				<ul
					css={{
						margin: 0,
						paddingLeft: spacing.lg,
						display: 'grid',
						gap: spacing.sm,
					}}
				>
					{codemods.map((codemod) => (
						<li key={codemod.id}>
							<code css={{ fontSize: typography.fontSize.sm }}>
								{codemod.id}
							</code>
							<p
								css={{
									margin: `${spacing.xs} 0 0`,
									color: colors.textMuted,
								}}
							>
								{codemod.description}
							</p>
						</li>
					))}
				</ul>
			)}
		</AccountManagementPanel>
	)
}
export function RunHistoryPanel(input: {
	runs: Array<AdminCodemodRunListItem>
	selectedHistoryRunId: string | null
	historyRun: AdminCodemodRunListItem | null
	historyItems: Array<AdminCodemodRunItemListItem>
	historyLoading: boolean
	historyNextAfterId: string | null
	canMutate: boolean
	isRevertConfirmActive: (runId: string) => boolean
	getDestructiveButtonProps: DestructiveButtonProps
	onShowDetails: (runId: string) => void
	onLoadMore: () => void
	onRevert: (run: AdminCodemodRunListItem) => void
}) {
	const {
		runs,
		selectedHistoryRunId,
		historyRun,
		historyItems,
		historyLoading,
		historyNextAfterId,
		canMutate,
	} = input
	return (
		<AccountManagementPanel
			title="Run history"
			description="Recent fleet and filtered package codemod runs."
		>
			{runs.length === 0 ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					No runs recorded yet.
				</p>
			) : (
				<RecordTable
					mode="expand"
					ariaLabel="Codemod run history"
					selectedId={selectedHistoryRunId}
					columns={[
						{ key: 'run', label: 'Run', primary: true },
						{ key: 'created', label: 'Created' },
						{ key: 'codemod', label: 'Codemod', drop: 1 },
						{ key: 'mode', label: 'Mode' },
						{ key: 'status', label: 'Status' },
						{ key: 'scope', label: 'Scope', drop: 2 },
						{ key: 'initiatedBy', label: 'Initiated by', drop: 3 },
						{ key: 'actions', label: 'Actions' },
					]}
					rows={runs.map((run) => {
						const revertConfirmActive = input.isRevertConfirmActive(run.id)
						// Abandoned and failed apply runs can hold applied items
						// too; only an actively-paging run is off limits for revert.
						const canRevert = run.mode === 'apply' && run.status !== 'running'
						return {
							id: run.id,
							cells: {
								run: (
									<code
										title={run.id}
										css={{ fontSize: typography.fontSize.sm }}
									>
										{run.id.slice(0, 8)}
									</code>
								),
								created: (
									<span css={recordStampCss}>
										{formatNullableTimestamp(run.createdAt)}
									</span>
								),
								codemod: (
									<code css={{ fontSize: typography.fontSize.sm }}>
										{run.codemodId}
									</code>
								),
								mode: run.mode,
								status: run.status,
								scope: (
									<span css={clampedCellCss}>{run.scopeUserId ?? 'fleet'}</span>
								),
								initiatedBy: (
									<span css={clampedCellCss}>{run.initiatedByUserId}</span>
								),
								actions: (
									<span
										css={{
											display: 'flex',
											gap: spacing.xs,
											flexWrap: 'wrap',
										}}
									>
										<button
											type="button"
											disabled={historyLoading}
											onClick={() => {
												input.onShowDetails(run.id)
											}}
											css={secondaryButtonCss}
										>
											{selectedHistoryRunId === run.id && historyLoading
												? 'Loading…'
												: 'Details'}
										</button>
										{canRevert ? (
											<button
												type="button"
												disabled={!canMutate}
												{...input.getDestructiveButtonProps(
													'revert-history',
													run.id,
													() => {
														input.onRevert(run)
													},
												)}
												css={dangerButtonCss}
											>
												{revertConfirmActive ? 'Confirm revert' : 'Revert'}
											</button>
										) : null}
									</span>
								),
							},
						}
					})}
					record={
						selectedHistoryRunId ? (
							<div css={recordBodyCss}>
								<p css={descriptionCss}>
									Details for <code>{selectedHistoryRunId}</code>
									{historyRun
										? ` · ${historyRun.mode} · ${historyRun.status}`
										: ''}
								</p>
								{historyLoading && historyItems.length === 0 ? (
									<p
										css={{
											margin: 0,
											color: colors.textMuted,
										}}
									>
										Loading items…
									</p>
								) : null}
								{historyItems.length > 0 ? (
									renderCodemodItemsTable({
										ariaLabel: 'Run items',
										items: historyItems,
									})
								) : !historyLoading ? (
									<p
										css={{
											margin: 0,
											color: colors.textMuted,
										}}
									>
										No items for this run.
									</p>
								) : null}
								{historyNextAfterId ? (
									<button
										type="button"
										disabled={historyLoading}
										onClick={() => {
											input.onLoadMore()
										}}
										css={secondaryButtonCss}
									>
										{historyLoading ? 'Loading…' : 'Load more'}
									</button>
								) : null}
							</div>
						) : null
					}
				/>
			)}
		</AccountManagementPanel>
	)
}

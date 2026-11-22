/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { formatFindings } from '#client/routes/admin-codemods-shared.ts'
import type {
	AdminCodemodListItem,
	AdminCodemodRunItemListItem,
	AdminCodemodRunListItem,
} from '#universal/loader-data.ts'
import { descriptionCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { css } from '@emotion/react'
import type { ButtonHTMLAttributes } from 'react'
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
	{ key: 'userId', label: 'userId' },
	{ key: 'status', label: 'status' },
	{ key: 'changedPaths', label: 'changedPaths' },
	{ key: 'findings', label: 'findings' },
	{ key: 'error', label: 'error' },
]
const clampedCellCss = css(recordCellClamp(24))
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
						{ key: 'codemod', label: 'Codemod' },
						{ key: 'mode', label: 'Mode' },
						{ key: 'status', label: 'Status' },
						{ key: 'scope', label: 'Scope' },
						{ key: 'initiatedBy', label: 'Initiated by' },
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
										<Button
											type="button"
											disabled={historyLoading}
											onClick={() => {
												input.onShowDetails(run.id)
											}}
											variant="secondary"
										>
											{selectedHistoryRunId === run.id && historyLoading ? (
												<LoadingIndicator inline label="Loading details" />
											) : (
												'Details'
											)}
										</Button>
										{canRevert ? (
											<Button
												type="button"
												disabled={!canMutate}
												{...input.getDestructiveButtonProps(
													'revert-history',
													run.id,
													() => {
														input.onRevert(run)
													},
												)}
												variant="danger"
											>
												{revertConfirmActive ? 'Confirm revert' : 'Revert'}
											</Button>
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
									<LoadingIndicator label="Loading items…" />
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
									<Button
										type="button"
										disabled={historyLoading}
										onClick={() => {
											input.onLoadMore()
										}}
										variant="secondary"
									>
										{historyLoading ? (
											<LoadingIndicator inline label="Loading…" />
										) : (
											'Load more'
										)}
									</Button>
								) : null}
							</div>
						) : null
					}
				/>
			)}
		</AccountManagementPanel>
	)
}

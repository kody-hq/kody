/** @jsxImportSource @emotion/react */
import { useEffect, useRef, useId } from 'react'
import {
	type useRecordTableModel,
	type RecordTableOptions,
} from './record-table-model.ts'
import { type RecordTableColumn } from './record-table.tsx'
import { colors } from '#universal/styles/tokens.ts'
type Model = ReturnType<typeof useRecordTableModel>
const control = {
	padding: '0.25rem 0.45rem',
	fontSize: '0.75rem',
	color: colors.text,
	background: colors.surface,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.25rem',
}
export function RecordSelectionCheckbox({
	label,
	checked,
	mixed,
	disabled,
	onChange,
}: {
	label: string
	checked: boolean
	mixed?: boolean
	disabled?: boolean
	onChange: (value: boolean) => void
}) {
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = Boolean(mixed && !checked)
	}, [mixed, checked])
	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={label}
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.target.checked)}
		/>
	)
}
export function RecordTableDataControls({
	model,
	columns,
	options,
}: {
	model: Model
	columns: Array<RecordTableColumn>
	options: RecordTableOptions
}) {
	const menuId = useId()
	const trigger = useRef<HTMLButtonElement>(null)
	const panel = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const reposition = () => {
			if (!panel.current || !trigger.current) return
			const rect = trigger.current.getBoundingClientRect()
			panel.current.style.left = `${Math.max(8, Math.min(rect.right - 208, window.innerWidth - 216))}px`
			panel.current.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - panel.current.offsetHeight - 8)}px`
		}
		const menu = panel.current
		menu?.addEventListener('toggle', reposition)
		window.addEventListener('resize', reposition)
		window.addEventListener('scroll', reposition, true)
		return () => {
			menu?.removeEventListener('toggle', reposition)
			window.removeEventListener('resize', reposition)
			window.removeEventListener('scroll', reposition, true)
		}
	}, [])
	const selectedIds = Object.entries(options.selection?.value ?? {})
		.filter(([, selected]) => selected)
		.map(([id]) => id)
	const selected = model.getSelectedRowModel().rows.map((row) => row.original)
	return (
		<div css={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
			{options.selection && selectedIds.length ? (
				<>
					<span>{selectedIds.length} selected</span>
					{options.selection.actions(selected, selectedIds)}
				</>
			) : null}
			<button
				ref={trigger}
				type="button"
				popoverTarget={menuId}
				css={{ ...control, marginLeft: 'auto', cursor: 'pointer' }}
			>
				Columns
			</button>
			<div
				ref={panel}
				id={menuId}
				popover="auto"
				css={{
					position: 'fixed',
					margin: 0,
					width: '13rem',
					maxWidth: 'calc(100vw - 16px)',
					maxHeight: 'calc(100dvh - 16px)',
					overflowY: 'auto',
					padding: '0.5rem',
					background: colors.surface,
					color: colors.text,
					border: `1px solid ${colors.border}`,
					borderRadius: '0.25rem',
					boxShadow: '0 4px 16px #0002',
				}}
			>
				{columns.map((column) => (
					<label
						key={column.key}
						css={{
							display: 'flex',
							gap: '0.5rem',
							padding: '0.25rem',
							fontSize: '0.8rem',
						}}
					>
						<input
							type="checkbox"
							checked={model.getColumn(column.key)!.getIsVisible()}
							disabled={!model.getColumn(column.key)!.getCanHide()}
							onChange={(event) =>
								model
									.getColumn(column.key)!
									.toggleVisibility(event.target.checked)
							}
						/>
						{column.label}
					</label>
				))}
			</div>
		</div>
	)
}
export function RecordTablePagination({ model }: { model: Model }) {
	const { pageIndex, pageSize } = model.state.pagination
	const total = model.getRowCount()
	return (
		<div
			css={{
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				justifyContent: 'flex-end',
				gap: '0.5rem',
				padding: '0.5rem 0.65rem',
				fontSize: '0.75rem',
				borderTop: `1px solid ${colors.border}`,
			}}
		>
			<span css={{ marginRight: 'auto' }}>
				{total ? pageIndex * pageSize + 1 : 0}–
				{Math.min(
					pageIndex * pageSize + model.getRowModel().rows.length,
					total,
				)}{' '}
				of {total}
			</span>
			<label>
				Rows{' '}
				<select
					aria-label="Rows per page"
					css={control}
					value={pageSize}
					onChange={(event) =>
						model.setPagination({
							pageIndex: 0,
							pageSize: Number(event.target.value),
						})
					}
				>
					{[10, 25, 50, 100].map((size) => (
						<option key={size} value={size}>
							{size}
						</option>
					))}
				</select>
			</label>
			<button
				type="button"
				css={control}
				aria-label="Previous page"
				disabled={!model.getCanPreviousPage()}
				onClick={() => model.previousPage()}
			>
				‹
			</button>
			<span>
				Page {pageIndex + 1} of {Math.max(1, model.getPageCount())}
			</span>
			<button
				type="button"
				css={control}
				aria-label="Next page"
				disabled={!model.getCanNextPage()}
				onClick={() => model.nextPage()}
			>
				›
			</button>
		</div>
	)
}

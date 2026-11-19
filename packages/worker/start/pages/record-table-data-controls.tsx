/** @jsxImportSource @emotion/react */
import type {
	useRecordTableModel,
	RecordTableOptions,
} from './record-table-model.ts'
import type { RecordTableColumn } from './record-table.tsx'
import {
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuTrigger,
} from '../components/menu.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { Select } from '../components/input.tsx'
import { Button } from '../components/button.tsx'
import { Checkbox } from '../components/choice-controls.tsx'
type Model = ReturnType<typeof useRecordTableModel>
export function RecordSelectionCheckbox({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string
	checked: boolean | 'mixed'
	disabled?: boolean
	onChange: (value: boolean) => void
}) {
	return (
		<Checkbox
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
	iconOnly = false,
}: {
	model: Model
	iconOnly?: boolean
	columns: Array<RecordTableColumn>
	options: RecordTableOptions
}) {
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
			<Menu>
				<MenuTrigger
					aria-label="Columns"
					title="Choose columns"
					render={
						<Button
							variant={iconOnly ? 'ghost' : 'secondary'}
							size="xs"
							iconOnly={iconOnly}
							css={{
								marginLeft: 'auto',
								'@media (any-pointer: coarse)': { minHeight: 28, minWidth: 28 },
							}}
						/>
					}
				>
					{iconOnly ? (
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.2"
						>
							<path d="M3 2v12M8 2v12m5-12v12" />
							<path d="M1 5h4M6 10h4m1-5h4" strokeWidth="2.5" />
						</svg>
					) : (
						'Columns'
					)}
				</MenuTrigger>
				<MenuContent
					align="end"
					aria-label="Choose columns"
					css={{ width: '13rem' }}
				>
					{columns.map((column) => {
						const modelColumn = model.getColumn(column.key)!
						return (
							<MenuCheckboxItem
								key={column.key}
								checked={modelColumn.getIsVisible()}
								disabled={!modelColumn.getCanHide()}
								onCheckedChange={(checked) =>
									modelColumn.toggleVisibility(checked)
								}
							>
								{column.label}
							</MenuCheckboxItem>
						)
					})}
				</MenuContent>
			</Menu>
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
				<Select
					size="sm"
					aria-label="Rows per page"
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
				</Select>
			</label>
			<Button
				type="button"
				variant="secondary"
				size="xs"
				aria-label="Previous page"
				disabled={!model.getCanPreviousPage()}
				onClick={() => model.previousPage()}
			>
				‹
			</Button>
			<span>
				Page {pageIndex + 1} of {Math.max(1, model.getPageCount())}
			</span>
			<Button
				type="button"
				variant="secondary"
				size="xs"
				aria-label="Next page"
				disabled={!model.getCanNextPage()}
				onClick={() => model.nextPage()}
			>
				›
			</Button>
		</div>
	)
}

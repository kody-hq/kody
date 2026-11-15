/** @jsxImportSource @emotion/react */
import type {
	useRecordTableModel,
	RecordTableOptions,
} from './record-table-model.ts'
import type { RecordTableColumn } from './record-table.tsx'
import { Menu } from '@base-ui/react/menu'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from '../components/overlay-styles.ts'
import { colors } from '#universal/styles/tokens.ts'
import { Select } from '../components/input.tsx'
import { Button } from '../components/button.tsx'
import { getSquircleCss } from '#universal/styles/style-primitives.ts'
import { Checkbox } from '../components/choice-controls.tsx'
type Model = ReturnType<typeof useRecordTableModel>
const control = {
	padding: '0.25rem 0.45rem',
	fontSize: '0.75rem',
	color: colors.text,
	background: colors.surface,
	border: `1px solid ${colors.border}`,
	...getSquircleCss('xs'),
}
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
			<Menu.Root modal={false}>
				<Menu.Trigger
					aria-label="Columns"
					title="Choose columns"
					css={{
						...control,
						marginLeft: 'auto',
						cursor: 'pointer',
						...(iconOnly
							? {
									width: 28,
									height: 28,
									padding: 4,
									display: 'grid',
									placeItems: 'center',
									border: 0,
									background: 'transparent',
									'&:hover': { background: colors.borderSubtle },
								}
							: {}),
					}}
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
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner
						align="end"
						sideOffset={4}
						css={overlayPositionerCss}
					>
						<Menu.Popup
							aria-label="Choose columns"
							css={{ ...overlayPopupCss, width: '13rem' }}
						>
							{columns.map((column) => {
								const modelColumn = model.getColumn(column.key)!
								return (
									<Menu.CheckboxItem
										key={column.key}
										checked={modelColumn.getIsVisible()}
										disabled={!modelColumn.getCanHide()}
										onCheckedChange={(checked) =>
											modelColumn.toggleVisibility(checked)
										}
										css={overlayItemCss}
									>
										<span css={{ width: '1rem' }}>
											<Menu.CheckboxItemIndicator>✓</Menu.CheckboxItemIndicator>
										</span>
										{column.label}
									</Menu.CheckboxItem>
								)
							})}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
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

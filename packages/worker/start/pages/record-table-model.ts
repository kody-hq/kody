import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
	columnFilteringFeature,
	globalFilteringFeature,
	rowSortingFeature,
	rowPaginationFeature,
	columnVisibilityFeature,
	rowSelectionFeature,
	createFilteredRowModel,
	createSortedRowModel,
	createPaginatedRowModel,
	filterFn_includesString,
	sortFn_text,
	tableFeatures,
	useTable,
	functionalUpdate,
	type ColumnDef,
	type SortingState,
	type ColumnFiltersState,
	type PaginationState,
	type RowSelectionState,
	type ColumnVisibilityState,
} from '@tanstack/react-table'
import { type RecordTableColumn, type RecordTableRow } from './record-table.tsx'

type RecordTableState = {
	sorting: SortingState
	columnFilters: ColumnFiltersState
	globalFilter: string
	pagination: PaginationState
}
export type RecordTableOptions = {
	state: RecordTableState
	onStateChange: (patch: Partial<RecordTableState>) => void
	/** Server mode trusts the supplied page and total, without processing it again. */
	manual?: boolean
	rowCount?: number
	/** Visibility preferences are scoped to this stable table identifier. */
	visibilityKey?: string
	defaultHidden?: Array<string>
	selection?: {
		value: RowSelectionState
		onChange: (value: RowSelectionState) => void
		canSelect?: (row: RecordTableRow) => boolean
		/** IDs include selections on unloaded server pages; rows include loaded records only. */
		actions: (
			selected: Array<RecordTableRow>,
			selectedIds: Array<string>,
		) => ReactNode
	}
}
const recordTableFeatures = tableFeatures({
	columnFilteringFeature,
	globalFilteringFeature,
	rowSortingFeature,
	rowPaginationFeature,
	columnVisibilityFeature,
	rowSelectionFeature,
	filteredRowModel: createFilteredRowModel(),
	sortedRowModel: createSortedRowModel(),
	paginatedRowModel: createPaginatedRowModel(),
	filterFns: { includesString: filterFn_includesString },
	sortFns: { text: sortFn_text },
})
const emptySelection: RowSelectionState = {}

export function useRecordTableModel(
	columns: Array<RecordTableColumn>,
	rows: Array<RecordTableRow>,
	options?: RecordTableOptions,
) {
	const [visibility, setVisibility] = useState<ColumnVisibilityState>(() =>
		Object.fromEntries(
			(options?.defaultHidden ?? []).map((key) => [key, false]),
		),
	)
	const storageKey = options?.visibilityKey
		? `record-table:${options.visibilityKey}:columns`
		: null
	useEffect(() => {
		if (!storageKey) return
		try {
			const saved: unknown = JSON.parse(
				localStorage.getItem(storageKey) ?? 'null',
			)
			if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
				// Synchronize the optional browser preference after hydration.
				// eslint-disable-next-line react/set-state-in-effect
				setVisibility(
					Object.fromEntries(
						Object.entries(saved).filter(
							([, value]) => typeof value === 'boolean',
						),
					),
				)
			}
		} catch {
			/* Storage can be unavailable. The table remains usable. */
		}
	}, [storageKey])
	const enabled = Boolean(options)
	const defs = useMemo<
		Array<ColumnDef<typeof recordTableFeatures, RecordTableRow>>
	>(
		() =>
			columns.map((column) => ({
				id: column.key,
				accessorFn: (row) =>
					row.values?.[column.key] ??
					(typeof row.cells[column.key] === 'string' ||
					typeof row.cells[column.key] === 'number'
						? row.cells[column.key]
						: ''),
				enableSorting: enabled && column.sortable !== false,
				enableHiding: !column.primary && column.hideable !== false,
				enableGlobalFilter: column.searchable !== false,
				filterFn: column.filter
					? (row, id, value) =>
							column.filter!(row.getValue(id), value, row.original)
					: 'includesString',
			})),
		[columns, enabled],
	)
	const model = useTable({
		features: recordTableFeatures,
		columns: defs,
		data: rows,
		getRowId: (row) => row.id,
		manualPagination: !options || options.manual,
		manualSorting: !options || options.manual,
		manualFiltering: !options || options.manual,
		rowCount: options?.manual ? options.rowCount : undefined,
		autoResetPageIndex: false,
		enableSortingRemoval: false,
		enableRowSelection: options?.selection
			? (row) =>
					row.original.id !== '__new__' &&
					(options.selection?.canSelect?.(row.original) ?? true)
			: false,
		state: {
			...options?.state,
			columnVisibility: {
				...visibility,
				...Object.fromEntries(
					columns
						.filter((column) => column.primary || column.hideable === false)
						.map((column) => [column.key, true]),
				),
			},
			rowSelection: options?.selection?.value ?? emptySelection,
		},
		onSortingChange: (updater) =>
			options &&
			options.onStateChange({
				sorting: functionalUpdate(updater, options.state.sorting),
				pagination: { ...options.state.pagination, pageIndex: 0 },
			}),
		onColumnFiltersChange: (updater) =>
			options &&
			options.onStateChange({
				columnFilters: functionalUpdate(updater, options.state.columnFilters),
				pagination: { ...options.state.pagination, pageIndex: 0 },
			}),
		onGlobalFilterChange: (updater) =>
			options &&
			options.onStateChange({
				globalFilter: functionalUpdate(updater, options.state.globalFilter),
				pagination: { ...options.state.pagination, pageIndex: 0 },
			}),
		onPaginationChange: (updater) =>
			options &&
			options.onStateChange({
				pagination: functionalUpdate(updater, options.state.pagination),
			}),
		onRowSelectionChange: (updater) =>
			options?.selection?.onChange(
				functionalUpdate(updater, options.selection.value),
			),
		onColumnVisibilityChange: (updater) => {
			const next = functionalUpdate(updater, visibility)
			setVisibility(next)
			if (storageKey) {
				try {
					localStorage.setItem(storageKey, JSON.stringify(next))
				} catch {
					/* Optional preference storage. */
				}
			}
		},
		globalFilterFn: 'includesString',
	})
	// Direct links and deletions can leave a requested page beyond the new final page.
	const lastPage = Math.max(0, model.getPageCount() - 1)
	useEffect(() => {
		if (options && options.state.pagination.pageIndex > lastPage)
			options.onStateChange({
				pagination: { ...options.state.pagination, pageIndex: lastPage },
			})
	}, [options, lastPage])
	return model
}

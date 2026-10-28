/** @jsxImportSource @emotion/react */
import {
	useRecordTableModel,
	type RecordTableOptions,
} from './record-table-model.ts'
import {
	RecordTableDataControls,
	RecordTablePagination,
	RecordSelectionCheckbox,
} from './record-table-data-controls.tsx'
import { nestedSurfaceDarkCss } from '#universal/styles/surface.ts'
import { type CSSObject } from '@emotion/react'
import {
	useId,
	useMemo,
	useState,
	type ReactNode,
	type MouseEvent,
} from 'react'
import { SiteLink } from '../components/site-link.tsx'
import {
	colors,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getSurfaceCardCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import { visuallyHiddenCss } from './record-table-controls.tsx'

export {
	RecordChips,
	RecordDot,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
	recordStampCss,
} from './record-table-controls.tsx'

/*
 * The account and admin list/detail screens, as one table.
 *
 * Decision 0010: the record gets the whole content column instead of the
 * 434px right half of a split, and `mode` chooses where it renders rather
 * than which component the screen composes. Rows stay real anchors built
 * from `createListDetailLinks`, so the selected record stays in the URL and
 * scroll-preserving navigation continues to work. The selected row (or the
 * off-window pane) carries `data-record-focus` so a deep link can scroll to
 * it instead of leaving the reader at the top of the list.
 *
 * Sizing is answered by container queries, not viewport breakpoints: these
 * tables live inside a 200px-railed shell. Rows scroll horizontally by
 * default; the toolbar offers an explicit stacked layout.
 */

type Slot = ReactNode

export type RecordTableColumn = {
	sortable?: boolean
	searchable?: boolean
	hideable?: boolean
	filter?: (value: unknown, filter: unknown, row: RecordTableRow) => boolean
	/** Pairs the column with the value under the same key in `row.cells`. */
	key: string
	label: string
	/** Numeric columns right-align and take tabular figures. */
	align?: 'end'
	/** Legacy layout hint. Columns now stay visible when the table narrows. */
	drop?: 1 | 2 | 3
	/**
	 * The row's heading: carries the link, and is the card's title rather
	 * than a labeled field below 620px. Exactly one column should set it.
	 */
	primary?: boolean
}

export type RecordTableRow = {
	/** Raw values for sorting/filtering, separate from rendered cells. */
	values?: Record<string, string | number | boolean | null>
	selectionLabel?: string
	id: string
	/** Omitted for `mode: 'none'`, and while a mutation is in flight. */
	href?: string
	/** Keyed by column key; a missing key renders an empty cell. */
	cells: Record<string, Slot>
	/**
	 * Interactive control after the primary name link. RecordTable wraps
	 * the primary cell in `<SiteLink>`; keep buttons out of that link.
	 */
	primaryAccessory?: Slot
}

/** Synthetic row id for a `/new` create flow unfolded inside the table. */
const recordTableCreateId = '__new__'

/**
 * A create flow (`/new`) has no real row to expand under. Screens pass this
 * instead of building a one-off placeholder row and selected id.
 *
 * When `createRow` is set it always wins over `selectedId`: the synthetic
 * create row is the selection. Callers pass `createRow` only on `/new`.
 */
type RecordTableCreateRow = {
	href?: string
	label: string
}

function resolveRecordTableSelection({
	columns,
	rows,
	selectedId,
	createRow,
}: {
	columns: Array<RecordTableColumn>
	rows: Array<RecordTableRow>
	selectedId?: string | null
	createRow?: RecordTableCreateRow
}): {
	rows: Array<RecordTableRow>
	selectedId?: string | null
} {
	if (!createRow) {
		return { rows, selectedId }
	}
	const primary = columns.find((column) => column.primary) ?? columns[0]
	return {
		rows: [
			{
				id: recordTableCreateId,
				href: createRow.href,
				cells: primary ? { [primary.key]: createRow.label } : {},
			},
			...rows,
		],
		selectedId: recordTableCreateId,
	}
}

type RecordTableProps = {
	dataControls?: RecordTableOptions
	rowGroup?: (row: RecordTableRow) => string
	dense?: boolean
	/**
	 * `expand` unfolds the record inside the table under its own row,
	 * `pane` renders it below the table, `none` is a table with no selection.
	 * List/detail screens use `expand`, including editors (decision 0028).
	 * `pane` remains for the off-window selection fallback.
	 */
	mode: 'expand' | 'pane' | 'none'
	/**
	 * Names both the region and the table for assistive tech; there is no
	 * visible caption. The region carries it too because an empty collection
	 * renders no table, and the toolbar and count would otherwise sit in an
	 * unnamed part of the page.
	 */
	ariaLabel: string
	columns: Array<RecordTableColumn>
	rows: Array<RecordTableRow>
	selectedId?: string | null
	/**
	 * When set, prepends a selected create row and unfolds `record` under it.
	 * `/new` has no entity id, so without this the editor has nowhere to go
	 * in `expand` (and an empty collection would hide the table entirely).
	 */
	createRow?: RecordTableCreateRow
	/**
	 * The already-built record for `selectedId`. It is a prop rather than a
	 * `renderRecord(row)` callback because every one of these screens loads
	 * the record separately from the list — the detail is a different payload
	 * than the row, not a richer view of it.
	 */
	record?: Slot
	/** Collection controls: search, filters, the sort select. */
	toolbar?: Slot
	countLabel?: string
	/**
	 * A refetch is in flight. Reported in the count slot, which is already on
	 * the page — a page-level "Loading…" line above the table reflowed
	 * everything below it on every keystroke of a search that refetches.
	 */
	busy?: boolean
	/**
	 * The selected record is still being fetched. Off-window selections have
	 * no row to mark, so this keeps `data-record-focus-pending` until the
	 * pane exists. Not-found results must pass false (or omit it).
	 */
	recordLoading?: boolean
	emptyLabel?: string
	/** Actions under the empty copy, e.g. the screen's create link. */
	emptyAction?: Slot
	/** Below the table, inside its pane: the infinite-list "Load more" control. */
	footer?: Slot
	/**
	 * Pre-navigation state resets (clear messages, collapse confirmations) for
	 * the row being opened. Runs only for clicks the router takes as an SPA
	 * navigation; the id lets an editor seed its draft from the new selection
	 * before the loader answers.
	 */
	onNavigate?: (rowId: string) => void
	/**
	 * Scroll cap for `pane` and `none`. `expand` ignores it — see below.
	 */
	scrollHeight?: string
}

const defaultScrollHeight = '22rem'

const numericCss: CSSObject = {
	textAlign: 'right',
	fontVariantNumeric: 'tabular-nums',
}

const shellCss: CSSObject = {
	containerType: 'inline-size',
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const paneCss: CSSObject = {
	...getSurfaceCardCss(),
	background: colors.surface,
	boxShadow: `0 2px 8px color-mix(in srgb, ${colors.text} 3%, transparent)`,
	'@media (prefers-color-scheme: dark)': {
		...nestedSurfaceDarkCss,
		boxShadow: `0 2px 8px color-mix(in srgb, ${colors.background} 25%, transparent)`,
	},
	padding: 0,
	minWidth: 0,
	// Clip only the corners; the table scroller owns overflow so wide rows
	// scroll instead of disappearing under the rounded card edge.
	overflow: 'clip',
}

const tableScrollerCss: CSSObject = {
	width: '100%',
	minWidth: 0,
	overflowX: 'auto',
	WebkitOverflowScrolling: 'touch',
}

const toolbarCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
	padding: `0.7rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.borderSubtle}`,
	'@container (max-width: 620px)': {
		gap: spacing.xs,
	},
}

const countCss: CSSObject = {
	margin: `0 0 0 auto`,
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	whiteSpace: 'nowrap' as const,
	fontVariantNumeric: 'tabular-nums',
	// A refetch dims the count rather than replacing its text. The search field
	// beside it is `flex: 1 1 12rem`, so any width change here resizes the box
	// the reader is typing into.
	transition: `opacity 120ms ${transitions.easeOut}`,
	'&[data-busy]': { opacity: 0.45 },
	'@container (max-width: 620px)': { marginLeft: 0 },
}

const tableCss: CSSObject = {
	width: '100%',
	tableLayout: 'fixed' as const,
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
}

const headCellCss: CSSObject = {
	position: 'sticky' as const,
	top: 0,
	zIndex: 1,
	textAlign: 'left' as const,
	fontSize: '0.7rem',
	fontWeight: 700,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
	padding: `${spacing.xs} ${spacing.md}`,
	borderBottom: `1px solid ${colors.borderSubtle}`,
	whiteSpace: 'nowrap' as const,
	backgroundColor: colors.surface,
}

const cellCss: CSSObject = {
	padding: `0.55rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.borderSubtle}`,
	verticalAlign: 'middle' as const,
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
}

/** Stacking is an explicit display choice, independent of container width. */
const cardFallbackCss: CSSObject = {
	'& thead': { display: 'none' },
	'& table, & tbody, & tr, & td': { display: 'block', width: 'auto' },
	'& tbody tr[data-record-row]': { padding: 0 },
	'& tbody tr:not([data-record-row])': {
		borderBottom: `1px solid ${colors.borderSubtle}`,
		padding: `0.55rem ${spacing.md}`,
	},
	'& td': {
		textAlign: 'left',
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
		borderBottom: 0,
		padding: '0.1rem 0',
		display: 'flex',
		gap: spacing.sm,
		alignItems: 'baseline',
	},
	'& td:not([data-label])::before': { content: 'none' },
	'& td::before': {
		content: 'attr(data-label)',
		flex: 'none',
		minWidth: '6.5rem',
		fontSize: '0.68rem',
		fontWeight: 700,
		letterSpacing: '0.07em',
		textTransform: 'uppercase',
		color: colors.textMuted,
	},
	'& td[data-primary]': {
		display: 'block',
		fontSize: typography.fontSize.base,
		marginBottom: '0.2rem',
	},
	'& td[data-primary]::before': { content: 'none' },
	'& tr[data-record-row] > td': { padding: 0 },
	'& tr[data-record-row] > td::before': { content: 'none' },
}

const rowCss: CSSObject = {
	'&[data-selected]': {
		backgroundColor: colors.primarySoftest,
		boxShadow: `inset 3px 0 0 ${colors.primary}`,
	},
	// Same offset as `accountSectionCss`: clear the sticky site header when
	// scroll restoration lands on this row.
	'&[data-record-focus]': { scrollMarginTop: '5.5rem' },
	[hoverMq]: {
		'&:not([data-selected]):hover': { backgroundColor: colors.background },
	},
}

const primaryCellCss: CSSObject = {
	...cellCss,
	fontWeight: 620,
	whiteSpace: 'nowrap' as const,
	'@container (max-width: 620px)': {
		whiteSpace: 'normal',
		overflow: 'visible',
		overflowWrap: 'anywhere',
	},
}

const rowLinkCss: CSSObject = {
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'underline' },
}

const primaryCellContentCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	minWidth: 0,
}

const recordRowCss: CSSObject = {
	'& > td': {
		padding: 0,
		backgroundColor: colors.background,
		boxShadow: `inset 3px 0 0 ${colors.primary}`,
		borderBottom: `1px solid ${colors.borderSubtle}`,
		// The editor (datetime-local, combobox, long help text) must not
		// contribute min-content width back into the table.
		minWidth: 0,
	},
}

const emptyCss: CSSObject = {
	margin: 0,
	padding: spacing.lg,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const emptyStateCss: CSSObject = {
	...emptyCss,
	display: 'grid',
	gap: spacing.md,
	justifyItems: 'start',
}

const emptyActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
}

/** Padding and rhythm for whatever a screen renders as its record. */
export const recordBodyCss: CSSObject = {
	padding: spacing.lg,
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
	maxWidth: '100%',
}

const footerCss: CSSObject = {
	display: 'grid',
	padding: spacing.sm,
	borderTop: `1px solid ${colors.borderSubtle}`,
}

export function RecordTable(props: RecordTableProps) {
	const id = useId()
	const [stacked, setStacked] = useState(false)
	function columnCss(column: RecordTableColumn) {
		return [column.align === 'end' ? numericCss : null]
	}

	{
		const { mode, onNavigate } = props
		const resolved = useMemo(
			() =>
				resolveRecordTableSelection({
					columns: props.columns,
					rows: props.rows,
					selectedId: props.selectedId,
					createRow: props.createRow,
				}),
			[props.columns, props.rows, props.selectedId, props.createRow],
		)
		const model = useRecordTableModel(
			props.columns,
			resolved.rows,
			props.dataControls,
		)
		const columns = props.columns.filter((column) =>
			model.getColumn(column.key)!.getIsVisible(),
		)
		const modelRows = model.getRowModel().rows
		const rows = modelRows.map((row) => row.original)
		const selectedId = resolved.selectedId
		const hasSelection = Boolean(props.dataControls?.selection)
		const colSpan = columns.length + Number(hasSelection)
		const selectable = mode !== 'none'
		// `expand` must not cap the list: the record renders inside the
		// scroller, so a max-height traps it in a nested scroll you have to
		// fight to read. `pane` and `none` keep the cap, which is what keeps
		// the record below reachable without a long scroll first.
		const capped = mode !== 'expand'
		const selectedRowVisible =
			selectedId != null && rows.some((row) => row.id === selectedId)
		// `expand` puts the record inside the row it belongs to, which only works
		// while that row is on screen. A deep link, a filter, paging, or a
		// not-found selection leaves a loaded record with no row to unfold under
		// — so it falls back to a pane below the table rather than disappearing.
		const expandedInTable = Boolean(
			mode === 'expand' && props.record && selectedRowVisible,
		)
		const orphanedRecord = Boolean(
			mode === 'expand' && props.record && !expandedInTable,
		)
		// Retry scroll restoration only while an off-window selection is still
		// loading. An in-list row already carries `data-record-focus`; a
		// not-found id must not keep the restorer spinning.
		const focusPending = Boolean(
			selectable &&
			selectedId != null &&
			!props.record &&
			!selectedRowVisible &&
			(props.recordLoading || props.busy),
		)

		const table = (
			<table
				aria-label={props.ariaLabel}
				css={[
					tableCss,
					!stacked && { minWidth: `${Math.max(24, columns.length * 10)}rem` },
				]}
			>
				<thead>
					<tr>
						{hasSelection ? (
							<th css={headCellCss} scope="col">
								<RecordSelectionCheckbox
									label="Select this page"
									checked={model.getIsAllPageRowsSelected()}
									mixed={model.getIsSomePageRowsSelected()}
									onChange={(value) => model.toggleAllPageRowsSelected(value)}
								/>
							</th>
						) : null}
						{columns.map((column) => (
							<th
								key={column.key}
								scope="col"
								aria-sort={
									model.getColumn(column.key)!.getIsSorted() === 'asc'
										? 'ascending'
										: model.getColumn(column.key)!.getIsSorted() === 'desc'
											? 'descending'
											: undefined
								}
								data-drop={column.drop ? String(column.drop) : undefined}
								css={[headCellCss, ...columnCss(column)]}
							>
								{model.getColumn(column.key)!.getCanSort() ? (
									<button
										type="button"
										onClick={model
											.getColumn(column.key)!
											.getToggleSortingHandler()}
										css={{
											font: 'inherit',
											color: 'inherit',
											background: 'none',
											border: 0,
											padding: 0,
											cursor: 'pointer',
										}}
									>
										{column.label}{' '}
										<span aria-hidden="true">
											{model.getColumn(column.key)!.getIsSorted() === 'desc'
												? '↓'
												: model.getColumn(column.key)!.getIsSorted() === 'asc'
													? '↑'
													: '↕'}
										</span>
									</button>
								) : (
									column.label
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.flatMap((row, rowIndex) => {
						const selected = selectable && row.id === selectedId
						const recordRowId = `${id}-record-${row.id}`
						// A selected row with no record yet (still loading, or the detail
						// 404'd) renders no record row, so the link must not claim an
						// expanded region that is not in the DOM.
						const expanded = Boolean(
							selected && mode === 'expand' && props.record,
						)

						return [
							props.rowGroup &&
							(rowIndex === 0 ||
								props.rowGroup(rows[rowIndex - 1]!) !== props.rowGroup(row)) ? (
								<tr key={`group-${row.id}`}>
									<th
										colSpan={colSpan}
										scope="rowgroup"
										css={{ ...headCellCss, position: 'static' }}
									>
										{props.rowGroup(row)}
									</th>
								</tr>
							) : null,
							<tr
								key={row.id}
								data-selected={selected ? 'true' : undefined}
								data-record-focus={selected ? 'true' : undefined}
								css={rowCss}
							>
								{hasSelection ? (
									<td css={cellCss}>
										<RecordSelectionCheckbox
											label={`Select ${row.selectionLabel ?? row.id}`}
											checked={modelRows[rowIndex]!.getIsSelected()}
											disabled={!modelRows[rowIndex]!.getCanSelect()}
											onChange={(value) =>
												modelRows[rowIndex]!.toggleSelected(value)
											}
										/>
									</td>
								) : null}
								{columns.map((column) => {
									const content = row.cells[column.key] ?? null
									const rowHref = row.href
									const primaryLink =
										column.primary && rowHref ? (
											<SiteLink
												href={rowHref}
												data-prevent-scroll-reset
												aria-current={selected ? 'true' : undefined}
												aria-expanded={
													mode === 'expand'
														? expanded
															? 'true'
															: 'false'
														: undefined
												}
												aria-controls={expanded ? recordRowId : undefined}
												css={rowLinkCss}
												onClick={(event: MouseEvent<HTMLAnchorElement>) => {
													if (!onNavigate) return
													if (
														!(
															event.currentTarget instanceof HTMLAnchorElement
														) ||
														event.button !== 0 ||
														event.metaKey ||
														event.ctrlKey ||
														event.altKey ||
														event.shiftKey ||
														event.defaultPrevented
													) {
														return
													}
													onNavigate(row.id)
												}}
											>
												{content}
											</SiteLink>
										) : null
									return (
										<td
											key={column.key}
											data-label={column.label}
											data-drop={column.drop ? String(column.drop) : undefined}
											data-primary={column.primary ? 'true' : undefined}
											css={[
												column.primary ? primaryCellCss : cellCss,
												...columnCss(column),
											]}
										>
											{primaryLink && row.primaryAccessory ? (
												<span css={primaryCellContentCss}>
													{primaryLink}
													{row.primaryAccessory}
												</span>
											) : (
												(primaryLink ?? content)
											)}
										</td>
									)
								})}
							</tr>,
							expanded ? (
								<tr
									key={`${row.id}-record`}
									id={recordRowId}
									data-record-row="true"
									css={recordRowCss}
								>
									<td colSpan={colSpan}>{props.record}</td>
								</tr>
							) : null,
						]
					})}
				</tbody>
			</table>
		)

		return (
			<section
				aria-label={props.ariaLabel}
				aria-busy={props.busy ? 'true' : undefined}
				data-record-focus-pending={focusPending ? 'true' : undefined}
				css={shellCss}
			>
				<div
					css={[
						paneCss,
						props.dense && {
							borderRadius: '0.375rem',
							boxShadow: 'none',
							backgroundImage: 'none',
							'& table': { tableLayout: 'auto', fontSize: '0.8rem' },
							'& td, & th': { padding: '0.45rem 0.65rem' },
							'& th': {
								textTransform: 'none',
								letterSpacing: 0,
								fontWeight: 500,
							},
						},
						stacked && cardFallbackCss,
					]}
				>
					{props.toolbar ||
					props.countLabel ||
					props.dataControls ||
					rows.length > 0 ? (
						<div key="record-table-toolbar" css={toolbarCss}>
							{props.toolbar}
							<button
								type="button"
								aria-label="Stack rows"
								aria-pressed={stacked}
								title={stacked ? 'Show table rows' : 'Stack rows'}
								onClick={() => setStacked((value) => !value)}
								css={{
									marginLeft: 'auto',
									display: 'inline-flex',
									padding: '0.35rem',
									border: `1px solid ${colors.border}`,
									borderRadius: '0.3rem',
									color: colors.text,
									background: stacked ? colors.primarySoftest : colors.surface,
									cursor: 'pointer',
								}}
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									aria-hidden="true"
								>
									<rect x="1.5" y="2" width="13" height="12" rx="1" />
									<path
										d={
											stacked
												? 'M1.5 6h13M1.5 10h13'
												: 'M1.5 6h13M6 6v8M10.5 6v8'
										}
									/>
								</svg>
							</button>
							{props.dataControls ? (
								<RecordTableDataControls
									model={model}
									columns={props.columns}
									options={props.dataControls}
								/>
							) : null}
							{props.countLabel ? (
								<p css={countCss} data-busy={props.busy ? 'true' : undefined}>
									{props.countLabel}
								</p>
							) : null}
							{/*
							 * Out of flow, so announcing the refetch costs no layout.
							 * Polite because this narrates something the reader started;
							 * assertive would interrupt their own typing.
							 */}
							<span css={visuallyHiddenCss} aria-live="polite">
								{props.busy ? 'Updating…' : ''}
							</span>
						</div>
					) : null}
					{/*
					 * Keep a stable keyed host around the collection so filtering
					 * from some rows to none (or the reverse) replaces only the
					 * inner empty copy / table, not a sibling of the toolbar. An
					 * unkeyed type swap next to the search field remounts it and
					 * drops focus on the keystroke that emptied the list.
					 */}
					<div key="record-table-collection">
						{rows.length === 0 ? (
							props.emptyAction ? (
								<div css={emptyStateCss} data-testid="record-table-empty">
									<p css={{ margin: 0 }}>
										{props.emptyLabel ?? 'Nothing to show yet.'}
									</p>
									<div css={emptyActionsCss}>{props.emptyAction}</div>
								</div>
							) : (
								<p css={emptyCss}>
									{props.emptyLabel ?? 'Nothing to show yet.'}
								</p>
							)
						) : (
							<div
								role="region"
								aria-label={`${props.ariaLabel} rows`}
								tabIndex={stacked ? undefined : 0}
								css={{
									...tableScrollerCss,
									...(capped && !props.dataControls
										? {
												maxHeight: props.scrollHeight ?? defaultScrollHeight,
												overflowY: 'auto' as const,
											}
										: null),
								}}
							>
								{table}
							</div>
						)}
					</div>
					{props.dataControls ? <RecordTablePagination model={model} /> : null}
					{props.footer ? <div css={footerCss}>{props.footer}</div> : null}
				</div>
				{(mode === 'pane' || orphanedRecord) && props.record ? (
					<div
						data-record-focus={orphanedRecord ? 'true' : undefined}
						css={{ ...paneCss, scrollMarginTop: '5.5rem' }}
					>
						{props.record}
					</div>
				) : null}
			</section>
		)
	}
}

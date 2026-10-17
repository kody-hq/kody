/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useId, type ReactNode, type MouseEvent } from 'react'
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
 * tables live inside a 200px-railed shell, so the viewport says very little
 * about how much room the table actually has.
 */

type Slot = ReactNode

export type RecordTableColumn = {
	/** Pairs the column with the value under the same key in `row.cells`. */
	key: string
	label: string
	/** Numeric columns right-align and take tabular figures. */
	align?: 'end'
	/**
	 * Priority at which this column stops earning its width and drops out.
	 * `3` goes first. Columns squeeze equally without this, which is how a
	 * table ends up with five unreadable ones instead of three readable.
	 */
	drop?: 1 | 2 | 3
	/**
	 * The row's heading: carries the link, and is the card's title rather
	 * than a labeled field below 620px. Exactly one column should set it.
	 */
	primary?: boolean
}

export type RecordTableRow = {
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

/**
 * Columns drop one priority at a time as the container narrows, then the
 * whole table becomes cards. Each threshold is its own class so a cell can
 * carry exactly one.
 */
const dropHiddenTableCss = {
	width: 0,
	minWidth: 0,
	maxWidth: 0,
	paddingInline: 0,
	border: 'none',
	overflow: 'hidden',
	visibility: 'hidden',
	fontSize: 0,
	lineHeight: 0,
} as const

const dropCss: CSSObject = {
	1: { '@container (max-width: 680px)': dropHiddenTableCss },
	2: { '@container (max-width: 780px)': dropHiddenTableCss },
	3: { '@container (max-width: 900px)': dropHiddenTableCss },
} as const

const numericCss: CSSObject = {
	textAlign: 'right',
	fontVariantNumeric: 'tabular-nums',
	'@container (max-width: 620px)': { textAlign: 'left' },
}

const shellCss: CSSObject = {
	containerType: 'inline-size',
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}

const paneCss: CSSObject = {
	...getSurfaceCardCss(),
	padding: 0,
	minWidth: 0,
	// Clip only the corners; the table scroller owns overflow so wide rows
	// scroll instead of disappearing under the rounded card edge.
	overflow: 'clip',
}

const tableScrollerCss: CSSObject = {
	width: '100%',
	minWidth: 0,
	overflowX: 'hidden' as const,
	'@container (max-width: 400px)': {
		overflowX: 'auto' as const,
		WebkitOverflowScrolling: 'touch' as const,
	},
}

const toolbarCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
	padding: `0.7rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
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
	borderBottom: `1px solid ${colors.border}`,
	whiteSpace: 'nowrap' as const,
	backgroundColor: colors.surface,
}

const cellCss: CSSObject = {
	padding: `0.55rem ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	verticalAlign: 'middle' as const,
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
}

/**
 * Below 620px the same `<table>` becomes a list of cards — no duplicate DOM.
 * Cells carry their own label from `data-label`; the primary cell is the
 * card's heading and keeps none. Column `drop` priorities shed fields first.
 * `table-layout: fixed` keeps the table in the pane at normal widths; the
 * scroller only allows horizontal overflow on a very narrow container
 * (unbreakable leftovers, not five readable columns fighting for 26ch each).
 */
const cardFallbackCss: CSSObject = {
	'@container (max-width: 620px)': {
		'& thead': { display: 'none' },
		'& table, & tbody, & tr, & td': { display: 'block', width: 'auto' },
		'& tbody tr[data-record-row]': { padding: 0 },
		'& tbody tr:not([data-record-row])': {
			borderBottom: `1px solid ${colors.border}`,
			padding: `0.55rem ${spacing.md}`,
		},
		'& td': {
			borderBottom: 0,
			padding: '0.1rem 0',
			display: 'flex',
			gap: spacing.sm,
			alignItems: 'baseline',
		},
		'& td[data-drop]': { display: 'none' },
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
	},
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
		borderBottom: `1px solid ${colors.border}`,
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
	borderTop: `1px solid ${colors.border}`,
}

export function RecordTable(props: RecordTableProps) {
	const id = useId()
	function columnCss(column: RecordTableColumn) {
		return [
			column.align === 'end' ? numericCss : null,
			column.drop ? dropCss[column.drop] : null,
		]
	}

	{
		const { mode, columns, onNavigate } = props
		const { rows, selectedId } = resolveRecordTableSelection({
			columns,
			rows: props.rows,
			selectedId: props.selectedId,
			createRow: props.createRow,
		})
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
			<table aria-label={props.ariaLabel} css={tableCss}>
				<thead>
					<tr>
						{columns.map((column) => (
							<th
								key={column.key}
								scope="col"
								data-drop={column.drop ? String(column.drop) : undefined}
								css={[headCellCss, ...columnCss(column)]}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.flatMap((row) => {
						const selected = selectable && row.id === selectedId
						const recordRowId = `${id}-record-${row.id}`
						// A selected row with no record yet (still loading, or the detail
						// 404'd) renders no record row, so the link must not claim an
						// expanded region that is not in the DOM.
						const expanded = Boolean(
							selected && mode === 'expand' && props.record,
						)

						return [
							<tr
								key={row.id}
								data-selected={selected ? 'true' : undefined}
								data-record-focus={selected ? 'true' : undefined}
								css={rowCss}
							>
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
									<td colSpan={columns.length}>{props.record}</td>
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
				<div css={[paneCss, cardFallbackCss]}>
					{props.toolbar || props.countLabel ? (
						<div key="record-table-toolbar" css={toolbarCss}>
							{props.toolbar}
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
							<p css={emptyCss}>{props.emptyLabel ?? 'Nothing to show yet.'}</p>
						) : (
							<div
								css={{
									...tableScrollerCss,
									...(capped
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

import { type ComponentProps, createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	RecordTable,
	RecordTableSearch,
	type RecordTableColumn,
} from './pages/record-table.tsx'

const columns: Array<RecordTableColumn> = [
	{ key: 'name', label: 'Name', primary: true },
	{ key: 'kodyId', label: 'Kody id', drop: 2 },
	{ key: 'count', label: 'Count', align: 'end' },
]

const rows = [
	{
		id: 'a',
		href: '/account/packages/a',
		cells: { name: 'Alpha', count: '3' },
	},
	{ id: 'b', href: '/account/packages/b', cells: { name: 'Beta', count: '7' } },
]

type RecordTableProps = ComponentProps<typeof RecordTable>

const renderTable = (props: Partial<RecordTableProps>) =>
	renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Secrets',
			columns,
			rows,
			...props,
		}),
	)

test('record table keeps container drops, row links, and expand/pane selection contracts', async () => {
	const noneHtml = await renderTable({ mode: 'none' })

	// These tables live inside a 200px-railed shell, so the viewport says very
	// little about how much room the table actually has. A `@media` rule here
	// would drop a column on a wide screen and keep one in a narrow pane.
	expect(noneHtml).toContain('@container (max-width: 780px)')
	expect(noneHtml).not.toMatch(/@media \(max-width: \d+px\)/)
	expect(noneHtml).toContain('data-label="Kody id"')
	expect(noneHtml).toContain('data-primary="true"')

	// none mode ignores selection even when an id and record are passed.
	const noneWithSelection = await renderTable({
		mode: 'none',
		selectedId: 'a',
		record: jsx('p', { children: 'should not render' }),
	})
	expect(noneWithSelection).not.toContain('data-selected="true"')
	expect(noneWithSelection).not.toContain('should not render')
	expect(noneWithSelection).not.toContain('data-record-focus="true"')

	const expandHtml = await renderTable({
		selectedId: 'b',
		record: jsx('p', { children: 'Beta record' }),
	})

	// Rows stay real anchors, so the selected record is in the URL and the
	// scroll-preserving navigation continues to work.
	expect(expandHtml).toContain('href="/account/packages/b"')
	expect(expandHtml).toContain('data-prevent-scroll-reset')
	expect(expandHtml).toContain('aria-expanded="true"')
	expect(expandHtml).toContain('aria-expanded="false"')
	expect(expandHtml).toContain('data-record-focus="true"')
	expect(expandHtml).toContain('scroll-margin-top:5.5rem')
	const controls = /aria-controls="([^"]+)"/.exec(expandHtml)?.[1]
	expect(controls).toBeTruthy()
	expect(expandHtml).toContain(`id="${controls}"`)
	expect(expandHtml).toContain('Beta record')
	expect(expandHtml.match(/data-selected="true"/g)).toHaveLength(1)
	expect(expandHtml.match(/data-record-row="true"/g)).toHaveLength(1)
	expect(expandHtml.match(/data-record-focus="true"/g)).toHaveLength(1)
	expect(expandHtml).not.toContain('data-record-focus-pending')
	// Drop columns stay in the table track model (zero-width +
	// visibility:hidden) so expand colSpan cannot invent a phantom column
	// under table-layout:fixed (#2780). Cards remove them via data-drop.
	expect(expandHtml).toMatch(/visibility:\s*hidden/)
	expect(expandHtml).toMatch(/max-width:\s*0/)
	expect(expandHtml).toContain('data-drop="2"')
	expect(expandHtml).toContain('td[data-drop]')

	// Selected without a loaded record must not point assistive tech at a
	// missing expanded region.
	const expandPending = await renderTable({ selectedId: 'b' })
	expect(expandPending).not.toContain('aria-expanded="true"')
	expect(expandPending).not.toContain('aria-controls')
	expect(expandPending).not.toContain('data-record-row="true"')

	const paneHtml = await renderTable({
		mode: 'pane',
		selectedId: 'a',
		record: jsx('p', { children: 'Alpha editor' }),
	})
	expect(paneHtml).not.toContain('data-record-row="true"')
	expect(paneHtml.indexOf('Alpha editor')).toBeGreaterThan(
		paneHtml.indexOf('</table>'),
	)
	expect(paneHtml).toContain('data-selected="true"')

	// Off-window expand selection falls back to a pane after the table.
	const orphanHtml = await renderTable({
		selectedId: 'not-in-this-window',
		record: jsx('p', { children: 'Orphan record' }),
	})
	expect(orphanHtml).toContain('Orphan record')
	expect(orphanHtml).not.toContain('data-record-row="true"')
	expect(orphanHtml).toContain('data-record-focus="true"')
	expect(orphanHtml.indexOf('Orphan record')).toBeGreaterThan(
		orphanHtml.indexOf('</table>'),
	)
	expect(orphanHtml.indexOf('data-record-focus="true"')).toBeGreaterThan(
		orphanHtml.indexOf('</table>'),
	)

	// Off-window selection still loading: keep retrying scroll restoration
	// until the pane exists. List `busy` and detail `recordLoading` both
	// count. A not-found selection is not pending. An in-list row already
	// has `data-record-focus`, so it does not need the pending marker.
	const pendingBusyHtml = await renderTable({
		selectedId: 'not-in-this-window',
		busy: true,
	})
	expect(pendingBusyHtml).toContain('data-record-focus-pending="true"')
	expect(pendingBusyHtml).not.toContain('data-record-focus="true"')
	const pendingRecordHtml = await renderTable({
		selectedId: 'not-in-this-window',
		recordLoading: true,
	})
	expect(pendingRecordHtml).toContain('data-record-focus-pending="true"')
	expect(pendingRecordHtml).not.toContain('data-record-focus="true"')
	const inListBusyHtml = await renderTable({ selectedId: 'b', busy: true })
	expect(inListBusyHtml).toContain('data-record-focus="true"')
	expect(inListBusyHtml).not.toContain('data-record-focus-pending')
	const notFoundHtml = await renderTable({ selectedId: 'not-in-this-window' })
	expect(notFoundHtml).not.toContain('data-record-focus-pending')

	// A not-found record has no selected row. It must still render, not vanish.
	const missingHtml = await renderTable({
		selectedId: null,
		record: jsx('p', { children: 'Connection not found' }),
	})
	expect(missingHtml).toContain('Connection not found')
	expect(missingHtml).not.toContain('data-record-row="true"')
	expect(missingHtml.indexOf('Connection not found')).toBeGreaterThan(
		missingHtml.indexOf('</table>'),
	)

	// `/new` has no entity id. The create row is the row the editor unfolds
	// under, including when the collection is empty (no empty-state copy).
	const createHtml = await renderTable({
		rows: [],
		createRow: { href: '/account/secrets/new', label: 'New secret' },
		record: jsx('p', { children: 'Create editor' }),
		emptyLabel: 'No secrets yet.',
	})
	expect(createHtml).toContain('<table')
	expect(createHtml).not.toContain('No secrets yet.')
	expect(createHtml).toContain('New secret')
	expect(createHtml).toContain('Create editor')
	expect(createHtml).toContain('data-record-row="true"')
	expect(createHtml.indexOf('Create editor')).toBeGreaterThan(
		createHtml.indexOf('New secret'),
	)
	expect(createHtml.indexOf('Create editor')).toBeLessThan(
		createHtml.indexOf('</table>'),
	)

	// The table stays in the pane (`table-layout: fixed`). Horizontal overflow
	// is only for a very narrow container, not for five nowrap columns.
	const overflowHtml = await renderTable({})
	expect(overflowHtml).toContain('table-layout:fixed')
	expect(overflowHtml).toContain('overflow-x:hidden')
	expect(overflowHtml).toContain('@container (max-width: 400px)')
	expect(overflowHtml).toContain('overflow-x:auto')
	expect(overflowHtml).toContain('overflow:clip')
})

test('record table search renders its initial value outside the filtered rows', async () => {
	const toolbar = jsx(RecordTableSearch, {
		label: 'Search secrets',
		placeholder: 'Search secrets',
		value: 'api token',
		onInput: () => {},
	})
	const withRows = await renderTable({
		mode: 'none',
		toolbar,
		countLabel: '2 of 2 shown',
	})
	const filteredEmpty = await renderTable({
		mode: 'none',
		rows: [],
		toolbar,
		countLabel: '0 of 2 shown',
		emptyLabel: 'No secrets match the current filters.',
	})

	for (const html of [withRows, filteredEmpty]) {
		expect(html).toContain('role="searchbox"')
		expect(html).toContain('value="api token"')
		expect(html).toContain('aria-label="Search secrets"')
		expect(html).toContain('type="text"')
		expect(html).toMatch(/inputmode="search"/i)
		expect(html).not.toContain('type="search"')
	}
	expect(withRows.indexOf('role="searchbox"')).toBeLessThan(
		withRows.indexOf('<tbody'),
	)

	expect(withRows).toContain('<table')
	expect(filteredEmpty).not.toContain('<table')
	expect(filteredEmpty).toContain('No secrets match the current filters.')
	expect(filteredEmpty).toContain('0 of 2 shown')
})

test('record table empty and busy states keep toolbar layout stable', async () => {
	const emptyHtml = await renderTable({
		mode: 'pane',
		rows: [],
		emptyLabel: 'No secrets yet.',
		countLabel: '0 of 0 shown',
	})

	expect(emptyHtml).not.toContain('<table')
	expect(emptyHtml).toContain('0 of 0 shown')
	expect(emptyHtml).toContain('<section aria-label="Secrets"')

	const busyHtml = await renderTable({
		mode: 'pane',
		countLabel: '2 of 2 shown',
		busy: true,
	})

	// A page-level "Loading…" line above the table reflowed everything below it
	// on every keystroke of a search that refetches. The count dims in place
	// instead.
	expect(busyHtml).toContain('aria-busy="true"')
	expect(busyHtml).toContain('data-busy="true"')
	expect(busyHtml).toContain('2 of 2 shown')
	expect(busyHtml).toContain('aria-live="polite"')
	expect(busyHtml).toContain('<table')
})

test('record table keeps primary accessories outside the row link', async () => {
	const html = await renderTable({
		mode: 'none',
		rows: [
			{
				id: 'a',
				href: '/account/packages/a',
				cells: { name: 'Alpha' },
				primaryAccessory: jsx('button', {
					type: 'button',
					'data-testid': 'listing-ahead',
					children: 'Fork outdated',
				}),
			},
		],
	})

	expect(html).toContain('href="/account/packages/a"')
	expect(html).toContain('data-testid="listing-ahead"')
	expect(html).toMatch(/<\/a>[\s\S]*data-testid="listing-ahead"/)
	expect(html).not.toMatch(
		/<a[^>]*href="\/account\/packages\/a"[^>]*>[\s\S]*data-testid="listing-ahead"[\s\S]*<\/a>/,
	)
})

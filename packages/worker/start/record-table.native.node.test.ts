import { createElement as jsx } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { RecordTable } from './pages/record-table.tsx'

test('record table keeps row accessories outside the row link', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Packages',
			columns: [{ key: 'name', label: 'Name', primary: true }],
			rows: [
				{
					id: 'a',
					href: '/@ada/notes',
					cells: { name: 'Notes' },
					primaryAccessory: jsx('button', {
						type: 'button',
						children: 'Fork outdated',
					}),
				},
			],
		}),
	)

	expect(html).toContain('href="/@ada/notes"')
	expect(html).toContain('Fork outdated')
	expect(html).toMatch(/<\/a>[\s\S]*Fork outdated/)
})

test('email view filters expose every triage option through the custom combobox', async () => {
	const { RecordTableSelect } =
		await import('./pages/record-table-controls.tsx')
	const { emailViewOptions } = await import('./pages/email-triage-controls.tsx')
	const { emailMessageViewValues, emailMessageViewLabel } =
		await import('#universal/email-message-view.ts')
	const html = await renderToString(
		jsx(RecordTableSelect, {
			label: 'Email view',
			value: 'inbox',
			onChange: () => {},
			children: emailViewOptions,
		}),
	)
	expect(html.match(/role="option"/g)).toHaveLength(
		emailMessageViewValues.length,
	)
	for (const view of emailMessageViewValues) {
		expect(html).toContain(emailMessageViewLabel(view))
	}
})

const columns = [
	{ key: 'name', label: 'Name', primary: true },
	{ key: 'reads', label: 'Reads', searchable: false },
]
const rows = Array.from({ length: 30 }, (_, index) => ({
	id: String(index),
	cells: { name: `Skill ${index}`, reads: `${index} reads` },
	values: { name: `Skill ${index}`, reads: index },
}))
const state = {
	sorting: [{ id: 'reads', desc: true }],
	columnFilters: [],
	globalFilter: '',
	pagination: { pageIndex: 1, pageSize: 10 },
}

test('record table sorts raw values before paginating and keeps selection opt-in', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Skills',
			columns,
			rows,
			dataControls: { state, onStateChange: () => {} },
		}),
	)
	expect(html).toContain('Skill 19')
	expect(html).toContain('Skill 10')
	expect(html).not.toContain('Skill 29')
	expect(html).not.toContain('Skill 9<')
	expect(html.indexOf('Skill 19')).toBeLessThan(html.indexOf('Skill 10'))
	expect(html.replaceAll('<!-- -->', '')).toContain('11–20 of 30')
	expect(html).not.toContain('Select this page')
})

test('record table filters before paging, protects the primary column, and supports bulk selection', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Skills',
			columns,
			rows,
			dataControls: {
				state: {
					...state,
					globalFilter: 'Skill 2',
					pagination: { pageIndex: 0, pageSize: 10 },
				},
				onStateChange: () => {},
				defaultHidden: ['name', 'reads'],
				selection: {
					value: { '2': true },
					onChange: () => {},
					actions: (selected) => `Archive ${selected.length}`,
				},
			},
		}),
	)
	expect(html.replaceAll('<!-- -->', '')).toContain('1–10 of 11')
	expect(html).toContain('Skill 29')
	expect(html).not.toContain('Skill 19')
	expect(html).not.toContain('29 reads')
	expect(html).toContain('Select this page')
	expect(html).toContain('Archive 1')
})

test('manual record tables retain the supplied page and server count', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'none',
			ariaLabel: 'Skills',
			columns,
			rows: rows.slice(0, 2),
			dataControls: {
				state: { ...state, globalFilter: 'not present' },
				manual: true,
				rowCount: 42,
				onStateChange: () => {},
			},
		}),
	)
	expect(html).toContain('Skill 0')
	expect(html).toContain('Skill 1')
	expect(html.replaceAll('<!-- -->', '')).toContain('of 42')
})

test('paginated records keep an off-page selected detail accessible', async () => {
	const html = await renderToString(
		jsx(RecordTable, {
			mode: 'expand',
			ariaLabel: 'Skills',
			columns,
			rows,
			selectedId: '29',
			record: 'Selected skill details',
			dataControls: { state, onStateChange: () => {} },
		}),
	)
	expect(html).toContain('Selected skill details')
	expect(html).not.toContain('Skill 29')
})

test('existing callers keep every supplied row without pagination controls', async () => {
	const html = await renderToString(
		jsx(RecordTable, { mode: 'none', ariaLabel: 'Skills', columns, rows }),
	)
	expect(html).toContain('Skill 29')
	expect(html).not.toContain('Rows per page')
	expect(html).not.toContain('Select this page')
})

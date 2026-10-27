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

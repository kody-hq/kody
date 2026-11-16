import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { RecordTablePagination } from './record-table-data-controls.tsx'

test('pagination buttons do not submit an enclosing form', () => {
	const model = {
		state: { pagination: { pageIndex: 0, pageSize: 25 } },
		getRowCount: () => 60,
		getRowModel: () => ({ rows: Array.from({ length: 25 }) }),
		setPagination: () => {},
		getCanPreviousPage: () => false,
		getCanNextPage: () => true,
		previousPage: () => {},
		nextPage: () => {},
		getPageCount: () => 3,
	} as unknown as Parameters<typeof RecordTablePagination>[0]['model']
	const html = renderToStaticMarkup(
		createElement(RecordTablePagination, { model }),
	)
	const buttons = html.match(/<button\b[^>]*>/g) ?? []
	expect(buttons).toHaveLength(2)
	for (const button of buttons) expect(button).toContain('type="button"')
})

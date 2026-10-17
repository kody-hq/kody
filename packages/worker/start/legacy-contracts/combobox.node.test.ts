import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { Combobox } from '../components/combobox.tsx'

const options = [
	{ id: '', label: 'All packages' },
	{
		id: '4ad2f1d3-8ea9-4f31-995c-45d59972e665',
		label: 'rotosphere',
		keywords: ['4ad2f1d3-8ea9-4f31-995c-45d59972e665'],
	},
	{
		id: '121967c1-7c71-4192-8616-0d27ff07d179',
		label: 'court-projector',
		keywords: ['121967c1-7c71-4192-8616-0d27ff07d179'],
	},
]

test('combobox shows the selected label, keeps ids out of the list, and can hide its label', async () => {
	const selectedHtml = await renderToString(
		jsx(Combobox, {
			id: 'package-filter',
			label: 'Filter secrets by package',
			hideLabel: true,
			placeholder: 'All packages',
			value: '4ad2f1d3-8ea9-4f31-995c-45d59972e665',
			options,
			onChange: () => {},
		}),
	)

	// The field reads the package name, never the UUID behind it.
	expect(selectedHtml).toMatch(/<input[^>]*value="rotosphere"/)
	expect(selectedHtml.replace(/<[^>]*>/g, '')).not.toContain(
		'4ad2f1d3-8ea9-4f31-995c-45d59972e665',
	)
	expect(selectedHtml).toContain('>rotosphere<')
	expect(selectedHtml).toContain('>court-projector<')
	// One row per option: the id is a search keyword, not a second line.
	expect(selectedHtml.match(/role="option"/g)).toHaveLength(3)
	// The label still names the field for assistive tech.
	expect(selectedHtml).toContain('Filter secrets by package')
	expect(selectedHtml).toMatch(/<input[^>]*id="package-filter"/)
	expect(selectedHtml).toMatch(/<label[^>]*for="package-filter"/)
	expect(selectedHtml).toContain('data-field-ring')

	// An empty value shows the placeholder rather than the "all" option's text,
	// so typing to filter starts on an empty field.
	const emptyHtml = await renderToString(
		jsx(Combobox, {
			id: 'package-filter',
			label: 'Filter secrets by package',
			placeholder: 'All packages',
			value: '',
			options,
			onChange: () => {},
		}),
	)
	expect(emptyHtml).not.toMatch(/<input[^>]*value="All packages"/)
	expect(emptyHtml).toMatch(/<input[^>]*placeholder="All packages"/)
})

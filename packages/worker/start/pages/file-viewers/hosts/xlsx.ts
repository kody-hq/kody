import readXlsxFile from 'read-excel-file/universal'
import { officeHost } from './host.ts'
officeHost('xlsx', async (bytes, root) => {
	const sheets = await readXlsxFile(bytes)
	const tabs = document.createElement('nav')
	tabs.setAttribute('aria-label', 'Sheets')
	const viewport = document.createElement('div')
	viewport.className = 'sheet-viewport'
	function show(index: number) {
		for (const [i, button] of Array.from(
			tabs.querySelectorAll('button'),
		).entries())
			button.setAttribute('aria-pressed', String(i === index))
		const table = document.createElement('table'),
			sheet = sheets[index]!
		const header = document.createElement('tr')
		header.append(document.createElement('th'))
		const width = Math.min(
			200,
			sheet.data.reduce((width, row) => Math.max(width, row.length), 0),
		)
		for (let i = 0; i < width; i++) {
			const cell = document.createElement('th')
			let n = i + 1,
				label = ''
			while (n) {
				n--
				label = String.fromCharCode(65 + (n % 26)) + label
				n = Math.floor(n / 26)
			}
			cell.textContent = label
			header.append(cell)
		}
		const head = document.createElement('thead')
		head.append(header)
		table.append(head)
		const body = document.createElement('tbody')
		sheet.data.slice(0, 1000).forEach((row, index) => {
			const tr = document.createElement('tr'),
				number = document.createElement('th')
			number.textContent = String(index + 1)
			tr.append(number)
			for (let i = 0; i < width; i++) {
				const cell = document.createElement('td'),
					value = row[i]
				cell.textContent =
					value instanceof Date
						? value.toLocaleDateString()
						: value === null || value === undefined
							? ''
							: String(value)
				tr.append(cell)
			}
			body.append(tr)
		})
		table.append(body)
		viewport.replaceChildren(table)
		if (
			sheet.data.length > 1000 ||
			sheet.data.some((row) => row.length > 200)
		) {
			const note = document.createElement('p')
			note.textContent =
				'Showing the first 1,000 rows and 200 columns. Download the original for the full sheet.'
			viewport.prepend(note)
		}
	}
	sheets.forEach((sheet, index) => {
		const button = document.createElement('button')
		button.textContent = sheet.sheet
		button.onclick = () => show(index)
		tabs.append(button)
	})
	root.replaceChildren(tabs, viewport)
	if (sheets.length) show(0)
})

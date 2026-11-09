export function parseCsvPreview(content: string): string[][] | null {
	const rows: string[][] = []
	let row: string[] = []
	// A quoted field can contain commas, line breaks, and doubled quotes.
	const source = content.replace(/^\uFEFF/, '')
	const field = /("(?:[^"]|"")*"|[^,\r\n"]*)(,|\r\n|\n|\r|$)/gy
	let offset = 0
	while (offset < source.length) {
		const match = field.exec(source)
		if (!match || field.lastIndex === offset) return null
		offset = field.lastIndex
		const [, value = '', separator] = match
		row.push(
			value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value,
		)
		if (separator !== ',') {
			rows.push(row)
			row = []
		}
	}
	if (row.length) rows.push([...row, ''])
	return rows
}

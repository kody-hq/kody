import { officeHost } from './host.ts'
import {
	openOffice,
	descendants,
	contentPreview,
	paragraph,
	table,
} from './office-content.ts'
officeHost('docx', async (bytes, root) => {
	const office = await openOffice(bytes)
	const document = await office.xml('word/document.xml')
	const body = descendants(document, 'body')[0]
	if (!body) throw new Error('Missing document body')
	const article = contentPreview(root)
	for (const child of Array.from(body.children)) {
		if (child.localName === 'p') article.append(paragraph(child, true))
		if (child.localName === 'tbl') article.append(table(child, true))
	}
})

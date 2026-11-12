import JSZip from 'jszip'

export async function openOffice(bytes: ArrayBuffer) {
	const zip = await JSZip.loadAsync(bytes)
	async function xml(path: string) {
		const file = zip.file(path)
		if (!file) throw new Error('Missing document part')
		const document = new DOMParser().parseFromString(
			await file.async('string'),
			'application/xml',
		)
		if (document.getElementsByTagName('parsererror').length)
			throw new Error('Invalid document XML')
		return document
	}
	return { xml }
}
export function descendants(node: Document | Element, name: string) {
	return Array.from(node.getElementsByTagNameNS('*', name))
}
export function contentPreview(root: HTMLElement) {
	const notice = document.createElement('span')
	notice.className = 'preview-notice'
	notice.textContent = 'Preview only'
	notice.title =
		'Content preview. Images, charts, and layout may be omitted. Download the original for the full document.'
	root.append(notice)
	const article = document.createElement('article')
	article.className = 'office-content'
	root.append(article)
	return article
}
/** Copy text into safe DOM nodes, never insert uploaded XML as HTML. */
export function paragraph(source: Element, word = false) {
	const style = descendants(source, 'pStyle')[0]?.getAttribute('w:val') ?? ''
	const heading = word ? /^Heading([1-6])$/i.exec(style)?.[1] : undefined
	const result = document.createElement(heading ? `h${heading}` : 'p')
	for (const node of descendants(source, 't')) {
		let text: Node = document.createTextNode(node.textContent ?? '')
		const run = node.parentElement
		if (run && descendants(run, 'b').length) {
			const strong = document.createElement('strong')
			strong.append(text)
			text = strong
		}
		if (run && descendants(run, 'i').length) {
			const em = document.createElement('em')
			em.append(text)
			text = em
		}
		result.append(text)
	}
	if (!result.textContent) result.append(document.createElement('br'))
	return result
}
export function table(source: Element, word = false) {
	const result = document.createElement('table')
	for (const row of descendants(source, 'tr')) {
		const tr = document.createElement('tr')
		for (const cell of Array.from(row.children).filter(
			(node) => node.localName === 'tc',
		)) {
			const td = document.createElement('td')
			for (const p of descendants(cell, 'p')) td.append(paragraph(p, word))
			tr.append(td)
		}
		result.append(tr)
	}
	return result
}

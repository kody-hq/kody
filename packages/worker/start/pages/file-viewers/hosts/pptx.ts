import { officeHost } from './host.ts'
import {
	openOffice,
	descendants,
	contentPreview,
	paragraph,
	table,
} from './office-content.ts'
officeHost('pptx', async (bytes, root) => {
	const office = await openOffice(bytes)
	const presentation = await office.xml('ppt/presentation.xml')
	const relations = await office.xml('ppt/_rels/presentation.xml.rels')
	const targets = new Map(
		descendants(relations, 'Relationship')
			.filter((node) => node.getAttribute('TargetMode') !== 'External')
			.map((node) => [node.getAttribute('Id'), node.getAttribute('Target')]),
	)
	const slides = descendants(presentation, 'sldId').map((node) => {
		const target = targets.get(node.getAttribute('r:id'))
		if (!target) throw new Error('Missing slide')
		const path = target.startsWith('/') ? target.slice(1) : `ppt/${target}`
		if (!/^ppt\/slides\/slide\d+\.xml$/.test(path))
			throw new Error('Invalid slide path')
		return path
	})
	if (!slides.length) throw new Error('No slides')
	const article = contentPreview(root),
		nav = document.createElement('nav'),
		canvas = document.createElement('section')
	nav.setAttribute('aria-label', 'Slide navigation')
	const previous = document.createElement('button'),
		next = document.createElement('button'),
		status = document.createElement('output')
	previous.textContent = 'Previous'
	next.textContent = 'Next'
	status.setAttribute('aria-label', 'Slide')
	status.setAttribute('aria-live', 'polite')
	nav.append(previous, status, next)
	article.append(nav, canvas)
	let index = 0,
		generation = 0
	async function show(value: number) {
		index = Math.max(0, Math.min(slides.length - 1, value))
		const request = ++generation,
			document = await office.xml(slides[index]!)
		if (request !== generation) return
		canvas.replaceChildren()
		for (const shape of descendants(document, 'spTree')[0]?.children ?? []) {
			if (shape.localName === 'sp')
				for (const p of descendants(shape, 'p')) canvas.append(paragraph(p))
			if (shape.localName === 'graphicFrame')
				for (const tbl of descendants(shape, 'tbl')) canvas.append(table(tbl))
		}
		status.textContent = `${index + 1} / ${slides.length}`
		previous.disabled = index === 0
		next.disabled = index === slides.length - 1
	}
	function navigate(value: number) {
		void show(value).catch(() =>
			parent.postMessage(
				{ type: 'kody-office-preview-status', state: 'error' },
				'*',
			),
		)
	}
	previous.onclick = () => {
		navigate(index - 1)
	}
	next.onclick = () => {
		navigate(index + 1)
	}
	document.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault()
			navigate(index + (event.key === 'ArrowLeft' ? -1 : 1))
		}
	})
	await show(0)
})

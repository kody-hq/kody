import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { acquisitionPages } from '#universal/acquisition/catalog.ts'
import { acquisitionMarkdown } from '#universal/acquisition/markdown.ts'
import { markdownResponse } from './markdown-negotiation.ts'

export function renderAcquisitionMarkdown(request: Request) {
	const pathname = new URL(request.url).pathname
	if (pathname === '/use-cases') {
		const index = acquisitionPageMeta.useCases
		return markdownResponse(
			[
				`# ${index.title}`,
				'',
				index.description,
				'',
				...acquisitionPages.map(
					(page) => `- [${page.title}](${page.path}): ${page.description}`,
				),
			].join('\n'),
		)
	}
	const page = acquisitionPages.find((entry) => entry.path === pathname)
	return page
		? markdownResponse(acquisitionMarkdown(page))
		: markdownResponse('Page not found', 404)
}

import { createServerFn } from '@tanstack/react-start'

const staticPages = {
	'/support': 'support',
	'/privacy': 'privacy',
	'/terms': 'terms',
	'/case-studies': 'caseStudies',
	'/faq': 'faq',
	'/pricing': 'pricing',
	'/discord': 'discord',
	'/login': 'login',
	'/signup': 'signup',
} as const
export const loadStaticPage = createServerFn({ method: 'GET' })
	.validator((pathname: string) => {
		if (!Object.hasOwn(staticPages, pathname)) throw new Error('Unknown page')
		return pathname as keyof typeof staticPages
	})
	.handler(async ({ data: pathname }) => {
		const { loadDocumentHead } = await import('./document-head.ts')
		return { head: loadDocumentHead(staticPages[pathname], pathname) }
	})

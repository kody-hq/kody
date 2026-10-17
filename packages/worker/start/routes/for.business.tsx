import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { BusinessRoute } from '../pages/business.tsx'
export const Route = createFileRoute('/for/business')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('business'),
	component: BusinessRoute,
})

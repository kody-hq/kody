/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { BrandGuideRoute } from '../pages/brand-guide.tsx'

export const Route = createFileRoute('/brand-guide')({
	staticData: {
		sessionVerification: 'public',
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
	},
	head: staticDocumentHead('brandGuide'),
	component: BrandGuideRoute,
})

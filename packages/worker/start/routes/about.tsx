/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { AboutRoute } from '../pages/about.tsx'

export const Route = createFileRoute('/about')({
	staticData: {
		sessionVerification: 'public',
		anonymousDocumentCache: 'marketing',
	},
	head: staticDocumentHead('about'),
	component: AboutRoute,
})

/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { BelieveRoute } from '../pages/believe.tsx'
export const Route = createFileRoute('/believe')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('believe'),
	component: BelieveRoute,
})

/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { ContactRoute } from '../pages/contact.tsx'

export const Route = createFileRoute('/contact')({
	staticData: {
		sessionVerification: 'public',
		anonymousDocumentCache: 'marketing',
	},
	head: staticDocumentHead('contact'),
	component: ContactRoute,
})

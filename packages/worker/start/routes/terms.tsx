/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { TermsRoute } from '../pages/terms.tsx'

export const Route = createFileRoute('/terms')({
	staticData: { sessionVerification: 'public' },
	head: staticDocumentHead('terms'),
	component: TermsRoute,
})

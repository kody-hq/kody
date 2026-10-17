/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { PrivacyRoute } from '../pages/privacy.tsx'

export const Route = createFileRoute('/privacy')({
	staticData: { sessionVerification: 'public' },
	head: staticDocumentHead('privacy'),
	component: PrivacyRoute,
})

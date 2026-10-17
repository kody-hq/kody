/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { acquisitionMarkdown } from '#start/server/markdown'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AcquisitionPage } from '../pages/acquisition.tsx'
import { SlackPage } from '../pages/acquisition/slack.tsx'
export const Route = createFileRoute('/integrations_/slack')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('slack'),
	server: {
		middleware: [negotiatedDocument],
		handlers: { GET: acquisitionMarkdown },
	},
	component: () => (
		<AcquisitionPage pageKey="slack">
			<SlackPage />
		</AcquisitionPage>
	),
})

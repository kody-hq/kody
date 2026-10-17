/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { acquisitionMarkdown } from '#start/server/markdown'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AcquisitionPage } from '../pages/acquisition.tsx'
import { AutomationPage } from '../pages/acquisition/automation.tsx'
export const Route = createFileRoute('/use-cases_/ai-workflow-automation')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('automation'),
	server: {
		middleware: [negotiatedDocument],
		handlers: { GET: acquisitionMarkdown },
	},
	component: () => (
		<AcquisitionPage pageKey="automation">
			<AutomationPage />
		</AcquisitionPage>
	),
})

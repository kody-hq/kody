/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { acquisitionMarkdown } from '#start/server/markdown'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AcquisitionPage } from '../pages/acquisition.tsx'
import { ScheduledWorkflowsPage } from '../pages/acquisition/scheduledWorkflows.tsx'
export const Route = createFileRoute('/use-cases_/scheduled-workflows')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('scheduledWorkflows'),
	server: {
		middleware: [negotiatedDocument],
		handlers: { GET: acquisitionMarkdown },
	},
	component: () => (
		<AcquisitionPage pageKey="scheduledWorkflows">
			<ScheduledWorkflowsPage />
		</AcquisitionPage>
	),
})

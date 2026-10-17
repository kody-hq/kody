/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { acquisitionMarkdown } from '#start/server/markdown'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AcquisitionPage } from '../pages/acquisition.tsx'
import { McpGatewayPage } from '../pages/acquisition/mcpGateway.tsx'
export const Route = createFileRoute('/use-cases_/mcp-gateway')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('mcpGateway'),
	server: {
		middleware: [negotiatedDocument],
		handlers: { GET: acquisitionMarkdown },
	},
	component: () => (
		<AcquisitionPage pageKey="mcpGateway">
			<McpGatewayPage />
		</AcquisitionPage>
	),
})

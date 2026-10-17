/** @jsxImportSource @emotion/react */
import { createFileRoute, notFound } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { WithAgentRoute } from '../pages/with-agent.tsx'
import { findWithAgent } from '#universal/with-agents.ts'
export const Route = createFileRoute('/with/$agent')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	beforeLoad: ({ params }) => {
		const agent = findWithAgent(params.agent ?? '')
		if (!agent) throw notFound()
		return { agent }
	},
	head: staticDocumentHead('withAgent'),
	component: Page,
})
function Page() {
	const { agent } = Route.useRouteContext()
	return <WithAgentRoute agent={agent} />
}

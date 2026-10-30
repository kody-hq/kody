/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadAgentClaimPage } from '#start/server/agent-claim'
import {
	handleAgentClaimPost,
	rejectAgentClaimMethod,
} from '#start/server/agent-claim-protocol'
import { AgentClaimRoute } from '../pages/agent-claim.tsx'

export const Route = createFileRoute('/agent/claim')({
	server: {
		handlers: {
			POST: handleAgentClaimPost,
			PUT: rejectAgentClaimMethod,
			PATCH: rejectAgentClaimMethod,
			DELETE: rejectAgentClaimMethod,
			OPTIONS: rejectAgentClaimMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		shell: { preserveLoginReturn: true },
	},
	head: staticDocumentHead('agentClaim'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => loadAgentClaimPage({ data: location.searchStr }),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<AgentClaimRoute key={location.searchStr} data={Route.useLoaderData()} />
	)
}

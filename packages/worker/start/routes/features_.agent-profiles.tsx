/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { AgentProfilesFeature } from '../pages/features/agent-profiles.tsx'
export const Route = createFileRoute('/features_/agent-profiles')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureAgentProfiles'),
	component: () => (
		<FeaturePage>
			<AgentProfilesFeature />
		</FeaturePage>
	),
})

/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { PricingPage } from '../pages/pricing.tsx'
import { useShellData } from './__root.tsx'
import { isFeatureFlagEnabled } from '#client/feature-flags.ts'
import { jevSearchRerankFlagKey } from '#universal/feature-flags/registry.ts'

export const Route = createFileRoute('/pricing')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	head: staticDocumentHead('pricing'),
	component: Pricing,
})
function Pricing() {
	const { session } = useShellData()
	return (
		<PricingPage
			isSignedIn={session !== null}
			showImprovedSearch={isFeatureFlagEnabled(session, jevSearchRerankFlagKey)}
		/>
	)
}

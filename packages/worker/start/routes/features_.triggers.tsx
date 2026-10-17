/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { TriggersFeature } from '../pages/features/triggers.tsx'
export const Route = createFileRoute('/features_/triggers')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureTriggers'),
	component: () => (
		<FeaturePage>
			<TriggersFeature />
		</FeaturePage>
	),
})

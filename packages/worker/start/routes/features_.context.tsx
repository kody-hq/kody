/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { ContextFeature } from '../pages/features/context.tsx'
export const Route = createFileRoute('/features_/context')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureContext'),
	component: () => (
		<FeaturePage>
			<ContextFeature />
		</FeaturePage>
	),
})

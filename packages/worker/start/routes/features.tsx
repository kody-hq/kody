/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { FeaturesOverview } from '../pages/features/overview.tsx'
export const Route = createFileRoute('/features')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('features'),
	component: () => (
		<FeaturePage overview>
			<FeaturesOverview />
		</FeaturePage>
	),
})

/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { AppsFeature } from '../pages/features/apps.tsx'
export const Route = createFileRoute('/features_/apps')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureApps'),
	component: () => (
		<FeaturePage>
			<AppsFeature />
		</FeaturePage>
	),
})
